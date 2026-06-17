<?php
/**
 * Plugin Name: Bud Media Replace
 * Plugin URI:  https://bud.agency
 * Description: Headless REST route to replace a media attachment's binary in place, keeping the same attachment ID, filename, and all existing URLs. Images and PDFs only. Requires PHP 8.0+.
 * Version:     1.5.0
 * Author:      Bud Agency
 * Author URI:  https://bud.agency
 * License:     GPL-2.0-or-later
 * Text Domain: bud-media-replace
 * Requires PHP: 8.0
 * Requires at least: 5.9
 */

declare(strict_types=1);

namespace BudAgency\MediaReplace;

// Abort if loaded outside WordPress.
defined('ABSPATH') || exit;

/**
 * Registers the REST API route on init.
 */
add_action('rest_api_init', function (): void {
    register_rest_route('bud/v1', '/media/(?P<id>\d+)/replace', [
        'methods'             => 'POST',
        'callback'            => __NAMESPACE__ . '\\handle_replace',
        'permission_callback' => __NAMESPACE__ . '\\check_permission',
        'args'                => [
            'id' => [
                'validate_callback' => fn($v) => is_numeric($v) && (int) $v > 0,
                'sanitize_callback' => 'absint',
                'required'          => true,
            ],
        ],
    ]);
});

/**
 * Permission callback — capability + per-attachment ownership.
 *
 *   1. `upload_files` — may manage media (App-Password compatible; do NOT use
 *      is_user_logged_in() which is false for non-cookie sessions).
 *   2. `edit_post $id` — may edit THIS attachment (blocks overwriting others' media).
 */
function check_permission(\WP_REST_Request $request): bool|\WP_Error
{
    if (! current_user_can('upload_files')) {
        return new \WP_Error('rest_forbidden', 'You do not have permission to replace media files.', ['status' => 403]);
    }

    $id = absint($request->get_param('id'));
    if ($id > 0 && ! current_user_can('edit_post', $id)) {
        return new \WP_Error('rest_forbidden', 'You do not have permission to edit this attachment.', ['status' => 403]);
    }

    return true;
}

/**
 * Route handler — replaces the file binary for attachment $id in place.
 *
 * Scope: images and PDFs only (the types this endpoint can content-validate, which
 * also covers the logo/badge/brochure-swap use case). The replacement must be the
 * SAME detected type as the original; the filename/path/URL are preserved.
 */
function handle_replace(\WP_REST_Request $request): \WP_REST_Response|\WP_Error
{
    $id = (int) $request->get_param('id');

    // --- 1. Validate the attachment -------------------------------------------
    $post = get_post($id);
    if (! $post || $post->post_type !== 'attachment') {
        return new \WP_Error('rest_not_found', sprintf('No attachment found with ID %d.', $id), ['status' => 404]);
    }

    // Defence-in-depth: re-assert per-attachment edit rights. The route's
    // permission_callback already enforces this; re-checking guards against a
    // future misregistration or the handler being reached via another path.
    if (! current_user_can('edit_post', $id)) {
        return new \WP_Error('rest_forbidden', 'You do not have permission to edit this attachment.', ['status' => 403]);
    }

    $existing_path = get_attached_file($id);
    if (! $existing_path) {
        return new \WP_Error('rest_server_error', 'Could not retrieve the existing file path for this attachment.', ['status' => 500]);
    }

    // fileinfo is required: without it, content-based type detection is impossible
    // and wp_check_filetype_and_ext() degrades to (spoofable) extension-only checks.
    if (! extension_loaded('fileinfo')) {
        return new \WP_Error('rest_server_error', 'The PHP fileinfo extension is required for secure media replacement.', ['status' => 500]);
    }

    // --- 2. SECURITY: confine all filesystem ops to the uploads directory ------
    // Resolve real paths, require the attachment's directory under the uploads
    // basedir, and refuse symlinks. Defends against a poisoned _wp_attached_file.
    $upload_dir = wp_upload_dir();
    if (! empty($upload_dir['error'])) {
        return new \WP_Error('rest_server_error', 'The uploads directory is not available.', ['status' => 500]);
    }
    $base_real   = realpath($upload_dir['basedir']);
    $target_dir  = dirname($existing_path);
    $target_real = realpath($target_dir);
    if (
        $base_real === false || $target_real === false
        || ($target_real !== $base_real && ! str_starts_with($target_real, $base_real . DIRECTORY_SEPARATOR))
    ) {
        return new \WP_Error('rest_forbidden', 'Attachment path is outside the uploads directory.', ['status' => 403]);
    }
    if (is_link($existing_path)) {
        return new \WP_Error('rest_forbidden', 'Refusing to replace a symlinked attachment.', ['status' => 403]);
    }

    $final_path = $existing_path;
    $max_size   = wp_max_upload_size();

    // --- 3. Receive incoming file bytes (size-capped) --------------------------
    $tmp_path = null;
    $new_name = null;

    if (! empty($_FILES['file']['tmp_name'])) {
        // (a) Multipart upload via $_FILES.
        $upload_file = $_FILES['file'];

        if ((int) $upload_file['error'] !== UPLOAD_ERR_OK) {
            return new \WP_Error('rest_upload_error', sprintf('PHP file upload error code: %d.', (int) $upload_file['error']), ['status' => 400]);
        }
        if (! is_uploaded_file($upload_file['tmp_name'])) {
            return new \WP_Error('rest_bad_request', 'Invalid file upload (not a POST upload).', ['status' => 400]);
        }
        if ((int) ($upload_file['size'] ?? 0) > $max_size) {
            return new \WP_Error('rest_request_entity_too_large', 'Upload exceeds the maximum allowed size.', ['status' => 413]);
        }

        $tmp_path = $upload_file['tmp_name'];
        $new_name = sanitize_file_name((string) $upload_file['name']);
    } else {
        // (b) Raw binary body — streamed to disk with a hard byte cap.
        $disposition = $request->get_header('Content-Disposition');
        if ($disposition && preg_match('/filename=["\']?([^"\';\s]+)["\']?/i', $disposition, $m)) {
            $new_name = sanitize_file_name(trim($m[1]));
        }

        $in = fopen('php://input', 'rb');
        if ($in === false) {
            return new \WP_Error('rest_bad_request', 'Could not read the request body.', ['status' => 400]);
        }
        $tmp_path = wp_tempnam($new_name ?? 'bud-replace');
        if ($tmp_path === false) {
            fclose($in);
            return new \WP_Error('rest_server_error', 'Could not create a temporary file.', ['status' => 500]);
        }
        $out = fopen($tmp_path, 'wb');
        if ($out === false) {
            fclose($in);
            @unlink($tmp_path);
            return new \WP_Error('rest_server_error', 'Could not open the temporary file for writing.', ['status' => 500]);
        }

        $written = 0;
        while (! feof($in)) {
            $chunk = fread($in, 1048576); // 1 MiB
            if ($chunk === false) {
                break;
            }
            $written += strlen($chunk);
            if ($written > $max_size) {
                fclose($in);
                fclose($out);
                @unlink($tmp_path);
                return new \WP_Error('rest_request_entity_too_large', 'Upload exceeds the maximum allowed size.', ['status' => 413]);
            }
            if ($chunk !== '' && fwrite($out, $chunk) === false) {
                fclose($in);
                fclose($out);
                @unlink($tmp_path);
                return new \WP_Error('rest_server_error', 'Could not write incoming bytes to the temporary file.', ['status' => 500]);
            }
        }
        fclose($in);
        fclose($out);

        if ($written === 0) {
            @unlink($tmp_path);
            return new \WP_Error('rest_bad_request', 'No file data received. Send a multipart upload or a raw binary body.', ['status' => 400]);
        }
    }

    // --- 4. SECURITY: detect the ACTUAL type from the bytes (never trust the
    //         client-declared MIME) and require it to equal the original. The
    //         filename/extension/URL are preserved, so only a same-type swap is
    //         valid (a logo/badge/brochure replacement is always same-type).
    $orig_mime = sanitize_mime_type(strtolower((string) get_post_mime_type($id)));

    $finfo       = finfo_open(FILEINFO_MIME_TYPE);
    $actual_mime = $finfo ? finfo_file($finfo, $tmp_path) : false;
    if ($finfo) {
        finfo_close($finfo);
    }
    if (! is_string($actual_mime) || $actual_mime === '') {
        @unlink($tmp_path);
        return new \WP_Error('rest_forbidden', 'Could not determine the type of the uploaded file.', ['status' => 415]);
    }
    $actual_mime = sanitize_mime_type(strtolower($actual_mime));
    // Normalise a couple of common libmagic aliases.
    $aliases     = ['image/x-png' => 'image/png', 'application/x-pdf' => 'application/pdf'];
    $actual_mime = $aliases[$actual_mime] ?? $actual_mime;

    if ($orig_mime === '' || $actual_mime !== $orig_mime) {
        @unlink($tmp_path);
        return new \WP_Error(
            'rest_forbidden',
            sprintf('The replacement file type "%s" must match the original attachment type "%s".', esc_html($actual_mime), esc_html($orig_mime ?: '(unknown)')),
            ['status' => 415]
        );
    }

    // --- 5. Strict allowlist + magic-byte validation against the FINAL filename ---
    // Pass the detected (not declared) MIME.
    $mime_check = validate_file_type($tmp_path, basename($final_path), $actual_mime);
    if (is_wp_error($mime_check)) {
        @unlink($tmp_path);
        return $mime_check;
    }

    // --- 6. Capture existing metadata. Old artifacts are cleaned up only AFTER a
    //         successful replace (step 8), so a failed replace leaves the original
    //         intact. ------------------------------------------------------------
    if (! function_exists('wp_delete_file_from_directory')) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
    }
    $old_meta = wp_get_attachment_metadata($id);

    // --- 7. Replace atomically -------------------------------------------------
    // Stage the bytes INSIDE the validated target directory, then do an atomic
    // same-directory rename. We never copy() onto $final_path: copy() follows a
    // destination symlink, whereas rename() replaces the directory entry itself.
    // Staging in $target_real also avoids a cross-device rename (EXDEV) at the
    // final step.
    $stage_path = wp_tempnam(basename($final_path), $target_real);
    if ($stage_path === false) {
        @unlink($tmp_path);
        return new \WP_Error('rest_server_error', 'Could not create a staging file.', ['status' => 500]);
    }
    // Move the validated bytes into the staging file. A cross-device temp dir is
    // handled by copy()+unlink — but only onto the staging file we just created
    // (a fresh, non-symlink path we control), never onto $final_path.
    if (! @rename($tmp_path, $stage_path)) {
        // Cross-device fallback. copy() FOLLOWS a destination symlink, so guard
        // against $stage_path being swapped between wp_tempnam() and here — it must
        // still be the regular file wp_tempnam created.
        if (is_link($stage_path) || ! is_file($stage_path)) {
            @unlink($tmp_path);
            return new \WP_Error('rest_conflict', 'Staging file was tampered with.', ['status' => 409]);
        }
        if (! @copy($tmp_path, $stage_path)) {
            @unlink($tmp_path);
            @unlink($stage_path);
            return new \WP_Error('rest_server_error', 'Could not stage the replacement file.', ['status' => 500]);
        }
        @unlink($tmp_path);
    }

    // TOCTOU guard: re-verify the destination immediately before the swap.
    if (realpath(dirname($final_path)) !== $target_real || is_link($final_path)) {
        @unlink($stage_path);
        return new \WP_Error('rest_conflict', 'The destination changed during the replace operation.', ['status' => 409]);
    }

    // Atomic same-directory rename (replaces a symlink entry rather than following it).
    if (! @rename($stage_path, $final_path)) {
        @unlink($stage_path);
        return new \WP_Error('rest_server_error', 'Could not overwrite the existing file. Check filesystem permissions.', ['status' => 500]);
    }

    // Post-swap guard: if $stage_path was swapped for a symlink in the race window,
    // rename() would have moved that symlink into place (rename moves the link
    // itself). Reject and remove it — unlink() on a symlink removes the link, never
    // its target — so the attachment URL can't be turned into an arbitrary-file read.
    $written_real = realpath($final_path);
    if (
        is_link($final_path) || $written_real === false
        || ($written_real !== $base_real && ! str_starts_with($written_real, $base_real . DIRECTORY_SEPARATOR))
    ) {
        @unlink($final_path);
        return new \WP_Error('rest_conflict', 'Destination was tampered with during replace.', ['status' => 409]);
    }

    // wp_tempnam() creates 0600 files; restore web-readable perms on the final file.
    @chmod($final_path, defined('FS_CHMOD_FILE') ? FS_CHMOD_FILE : 0644);

    // --- 8. Clean up ALL stale artifacts, then regenerate metadata -------------
    // Delete the previous size derivatives AND the full-size `original_image`
    // (for -scaled uploads), legacy `thumb`, and edit-backup files — so replacing
    // (e.g. redacting) an image does not leave an old copy publicly reachable.
    // Everything is confined to $target_real and never touches the file just written.
    $final_real = realpath($final_path) ?: $final_path;
    $delete_rel = static function ($rel) use ($target_real, $final_real): void {
        if (! is_string($rel) || $rel === '') {
            return;
        }
        $candidate = path_join($target_real, $rel);
        $cand_real = realpath($candidate);
        if ($cand_real === false) {
            return; // nothing on disk to delete
        }
        // Explicit containment — do not rely solely on wp_delete_file_from_directory.
        // (path_join with an absolute $rel returns $rel unchanged.)
        if ($cand_real !== $target_real && ! str_starts_with($cand_real, $target_real . DIRECTORY_SEPARATOR)) {
            return;
        }
        if ($cand_real === $final_real) {
            return; // never delete the canonical file just written
        }
        wp_delete_file_from_directory($candidate, $target_real);
    };
    if (is_array($old_meta)) {
        if (! empty($old_meta['sizes']) && is_array($old_meta['sizes'])) {
            foreach ($old_meta['sizes'] as $size_data) {
                if (! empty($size_data['file'])) {
                    $delete_rel($size_data['file']);
                }
            }
        }
        if (! empty($old_meta['original_image'])) {
            $delete_rel($old_meta['original_image']);
        }
        if (! empty($old_meta['thumb'])) {
            $delete_rel($old_meta['thumb']);
        }
    }
    $backup_sizes = get_post_meta($id, '_wp_attachment_backup_sizes', true);
    if (is_array($backup_sizes)) {
        foreach ($backup_sizes as $backup) {
            if (! empty($backup['file'])) {
                $delete_rel($backup['file']);
            }
        }
        delete_post_meta($id, '_wp_attachment_backup_sizes');
    }

    update_attached_file($id, $final_path);

    require_once ABSPATH . 'wp-admin/includes/image.php';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';

    // Fresh metadata; on failure store minimal state rather than stale references.
    $new_meta = wp_generate_attachment_metadata($id, $final_path);
    if (is_wp_error($new_meta) || ! is_array($new_meta)) {
        $new_meta = [];
    }
    wp_update_attachment_metadata($id, $new_meta);

    // --- 9. Return the updated attachment representation ------------------------
    $controller = new \WP_REST_Attachments_Controller('attachment');
    $attachment = get_post($id);
    if (! $attachment) {
        return new \WP_Error('rest_server_error', 'Attachment not found after replace.', ['status' => 500]);
    }
    $rest_request = new \WP_REST_Request('GET', '/wp/v2/media/' . $id);
    $rest_request->set_param('context', 'view');
    $item = $controller->prepare_item_for_response($attachment, $rest_request);
    if (is_wp_error($item)) {
        return $item;
    }
    $data = $controller->prepare_response_for_collection($item);

    return new \WP_REST_Response(
        [
            'id'            => $id,
            'source_url'    => $data['source_url'] ?? wp_get_attachment_url($id),
            'media_details' => $data['media_details'] ?? $new_meta,
            'mime'          => get_post_mime_type($id),
        ],
        200
    );
}

/**
 * Validates a file's type. Images and PDFs only — the types this endpoint can
 * content-validate end to end.
 *
 * Layer 0 — fileinfo required (checked by the caller too).
 * Layer 1 — strict allowlist (image/* + PDF; every entry has a magic-byte signature).
 * Layer 2 — WordPress-native detection via wp_check_filetype_and_ext() (filename + contents).
 * Layer 3 — magic-byte signature check.
 *
 * @param string      $file_path Absolute path to the temp file.
 * @param string      $filename  FINAL destination filename (extension checked matches
 *                               the file that will actually exist on disk).
 * @param string|null $declared  DETECTED MIME (from finfo), passed by the caller.
 * @return true|\WP_Error
 */
function validate_file_type(string $file_path, string $filename, ?string $declared): true|\WP_Error
{
    if (! extension_loaded('fileinfo')) {
        return new \WP_Error('rest_server_error', 'The PHP fileinfo extension is required for secure media replacement.', ['status' => 500]);
    }

    // Layer 1 — strict allowlist. Only content-validatable types are permitted.
    // (SVG excluded — needs a sanitizer; office/audio/video excluded — cannot be
    // reliably content-validated here.)
    $allowed_mimes = [
        'image/jpeg'      => true,
        'image/png'       => true,
        'image/gif'       => true,
        'image/webp'      => true,
        'application/pdf' => true,
    ];

    $declared_clean = $declared ? sanitize_mime_type(strtolower(trim($declared))) : '';

    if (! isset($allowed_mimes[$declared_clean])) {
        return new \WP_Error(
            'rest_forbidden',
            sprintf('File type "%s" is not permitted by this endpoint. Allowed types: %s.', esc_html($declared_clean ?: '(none)'), implode(', ', array_keys($allowed_mimes))),
            ['status' => 415]
        );
    }

    // Honour the per-user allowed set (roles may restrict types further).
    $wp_allowed = get_allowed_mime_types();
    if (! in_array($declared_clean, $wp_allowed, true)) {
        return new \WP_Error(
            'rest_forbidden',
            sprintf('File type "%s" is not permitted for your user role.', esc_html($declared_clean)),
            ['status' => 415]
        );
    }

    // Layer 2 — WordPress-native detection (filename + contents).
    if (! function_exists('wp_check_filetype_and_ext')) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
    }
    $wp_check = wp_check_filetype_and_ext($file_path, $filename, $wp_allowed);
    if (false === $wp_check['type']) {
        return new \WP_Error('rest_forbidden', sprintf('WordPress rejected the file type for "%s". Upload refused.', esc_html($filename)), ['status' => 415]);
    }
    if (! empty($wp_check['type']) && $wp_check['type'] !== $declared_clean) {
        return new \WP_Error(
            'rest_forbidden',
            sprintf('Detected type "%s" does not match the destination extension for "%s". Upload refused.', esc_html($declared_clean), esc_html($filename)),
            ['status' => 415]
        );
    }

    // Layer 3 — magic-byte validation. Each signature is offset => expected byte.
    // WebP requires the RIFF prefix AND the "WEBP" form-type at offset 8 — RIFF
    // alone also matches WAV/AVI (bytes 4-7 are the file size and are not checked).
    $signatures = [
        'image/jpeg'      => [0 => 0xFF, 1 => 0xD8, 2 => 0xFF],
        'image/png'       => [0 => 0x89, 1 => 0x50, 2 => 0x4E, 3 => 0x47, 4 => 0x0D, 5 => 0x0A, 6 => 0x1A, 7 => 0x0A],
        'image/gif'       => [0 => 0x47, 1 => 0x49, 2 => 0x46, 3 => 0x38],
        'image/webp'      => [0 => 0x52, 1 => 0x49, 2 => 0x46, 3 => 0x46, 8 => 0x57, 9 => 0x45, 10 => 0x42, 11 => 0x50],
        'application/pdf' => [0 => 0x25, 1 => 0x50, 2 => 0x44, 3 => 0x46],
    ];

    $expected = $signatures[$declared_clean];
    $needed   = max(array_keys($expected)) + 1;

    $fh = fopen($file_path, 'rb');
    if (! $fh) {
        return new \WP_Error('rest_server_error', 'Could not open the uploaded file for validation.', ['status' => 500]);
    }
    $header = fread($fh, $needed);
    fclose($fh);

    if (strlen($header) < $needed) {
        return new \WP_Error('rest_bad_request', 'Uploaded file is too small to validate.', ['status' => 400]);
    }

    $actual = array_values(unpack('C*', $header));
    foreach ($expected as $offset => $byte) {
        if (($actual[$offset] ?? null) !== $byte) {
            return new \WP_Error(
                'rest_forbidden',
                sprintf('File content does not match type "%s". Upload rejected.', esc_html($declared_clean)),
                ['status' => 415]
            );
        }
    }

    return true;
}
