<?php
/**
 * Plugin Name: Bud Media Replace
 * Plugin URI:  https://bud.agency
 * Description: Headless REST route to replace a media attachment's binary in place, keeping the same attachment ID, filename, and all existing URLs. Requires PHP 8.0+.
 * Version:     1.1.0
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
 * Permission callback — enforces both capability and per-attachment ownership.
 *
 * Two-layer check (mirrors WP core's wp/v2/media/<id> authorization model):
 *
 *   1. Generic capability: `upload_files` — confirms the user is allowed to
 *      manage media at all. Works with Application Passwords (Basic Auth)
 *      because WP authenticates the user before permission callbacks run.
 *      Do NOT use is_user_logged_in() here — it returns false for non-cookie
 *      sessions.
 *
 *   2. Per-object meta-cap: `edit_post $id` — confirms the authenticated user
 *      has edit rights on this specific attachment. Prevents a low-privileged
 *      uploader from overwriting an administrator's (or another user's) media.
 *      WP resolves `edit_post` to `edit_others_posts` when the post is owned
 *      by a different user, which Subscribers/Contributors do not have.
 *
 * @param \WP_REST_Request $request The incoming REST request (WP passes this automatically).
 * @return bool|\WP_Error
 */
function check_permission(\WP_REST_Request $request): bool|\WP_Error
{
    // Layer 1 — generic media capability.
    if (! current_user_can('upload_files')) {
        return new \WP_Error(
            'rest_forbidden',
            'You do not have permission to replace media files.',
            ['status' => 403]
        );
    }

    // Layer 2 — per-attachment ownership / edit rights.
    // absint() matches the sanitize_callback registered on the 'id' arg.
    $id = absint($request->get_param('id'));
    if ($id > 0 && ! current_user_can('edit_post', $id)) {
        return new \WP_Error(
            'rest_forbidden',
            'You do not have permission to edit this attachment.',
            ['status' => 403]
        );
    }

    return true;
}

/**
 * Route handler — replaces the file binary for attachment $id in place.
 *
 * Accepts either:
 *   (a) multipart form upload: file in $_FILES['file']
 *   (b) raw binary body with:
 *       Content-Type: <mime-type>
 *       Content-Disposition: attachment; filename="<name>"
 *
 * The original filename and attachment path are preserved so that all
 * existing URLs and theme references keyed to the attachment ID keep
 * working without any database or template changes.
 *
 * @param \WP_REST_Request $request
 * @return \WP_REST_Response|\WP_Error
 */
function handle_replace(\WP_REST_Request $request): \WP_REST_Response|\WP_Error
{
    $id = (int) $request->get_param('id');

    // --- 1. Validate the attachment ID ------------------------------------------

    $post = get_post($id);
    if (! $post || $post->post_type !== 'attachment') {
        return new \WP_Error(
            'rest_not_found',
            sprintf('No attachment found with ID %d.', $id),
            ['status' => 404]
        );
    }

    // --- 2. Retrieve the existing file path ------------------------------------

    $existing_path = get_attached_file($id);
    if (! $existing_path) {
        return new \WP_Error(
            'rest_server_error',
            'Could not retrieve the existing file path for this attachment.',
            ['status' => 500]
        );
    }

    // --- 3. Receive incoming file bytes ----------------------------------------

    $tmp_path    = null;
    $new_mime    = null;
    $new_name    = null;

    if (! empty($_FILES['file']['tmp_name'])) {
        // (a) Multipart upload via $_FILES
        $upload_file = $_FILES['file'];

        if ($upload_file['error'] !== UPLOAD_ERR_OK) {
            return new \WP_Error(
                'rest_upload_error',
                sprintf('PHP file upload error code: %d.', $upload_file['error']),
                ['status' => 400]
            );
        }

        $tmp_path = sanitize_text_field($upload_file['tmp_name']);
        $new_mime = sanitize_mime_type($upload_file['type']);
        $new_name = sanitize_file_name($upload_file['name']);
    } else {
        // (b) Raw binary body
        $raw = file_get_contents('php://input');

        if ($raw === false || strlen($raw) === 0) {
            return new \WP_Error(
                'rest_bad_request',
                'No file data received. Send a multipart upload or a raw binary body.',
                ['status' => 400]
            );
        }

        // Parse filename from Content-Disposition: attachment; filename="foo.png"
        $disposition = $request->get_header('Content-Disposition');
        if ($disposition && preg_match('/filename=["\']?([^"\';\s]+)["\']?/i', $disposition, $m)) {
            $new_name = sanitize_file_name(trim($m[1]));
        }

        // Parse MIME from Content-Type (strip parameters, e.g. "; boundary=…")
        $content_type = $request->get_header('Content-Type');
        if ($content_type) {
            $new_mime = sanitize_mime_type(strtolower(explode(';', $content_type)[0]));
        }

        // Write to a WordPress-managed temp file
        $tmp_path = wp_tempnam($new_name ?? 'bud-replace');
        if ($tmp_path === false) {
            return new \WP_Error(
                'rest_server_error',
                'Could not create a temporary file.',
                ['status' => 500]
            );
        }

        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
        if (file_put_contents($tmp_path, $raw) === false) {
            @unlink($tmp_path);
            return new \WP_Error(
                'rest_server_error',
                'Could not write incoming bytes to the temporary file.',
                ['status' => 500]
            );
        }
    }

    // --- 4. Security: strict MIME validation (allowlist + magic bytes) ---------

    $mime_check = validate_file_type($tmp_path, $new_name ?? basename($existing_path), $new_mime);
    if (is_wp_error($mime_check)) {
        @unlink($tmp_path);
        return $mime_check;
    }

    // --- 5. Determine final path — preserve original filename ------------------
    //
    // Default: keep the original filename and path so URLs do not change.
    // If the caller supplied a different name and the upload dir is writable,
    // we could rename — but the primary use-case (badge/logo swap) always
    // keeps the original name, so we default to that.

    $final_path = $existing_path;
    $upload_dir = wp_upload_dir();

    if ($upload_dir['error']) {
        @unlink($tmp_path);
        return new \WP_Error('rest_server_error', $upload_dir['error'], ['status' => 500]);
    }

    // Ensure the target directory exists (it should, but be defensive).
    $target_dir = dirname($final_path);
    if (! is_dir($target_dir)) {
        wp_mkdir_p($target_dir);
    }

    // --- 6. Overwrite the existing file ----------------------------------------

    // Delete old image size derivatives before overwriting so stale
    // thumbnails are cleaned up.
    $old_meta = wp_get_attachment_metadata($id);
    if (is_array($old_meta) && ! empty($old_meta['sizes'])) {
        foreach ($old_meta['sizes'] as $size_data) {
            $size_file = path_join($target_dir, $size_data['file']);
            if (file_exists($size_file)) {
                @unlink($size_file);
            }
        }
    }

    // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
    if (! rename($tmp_path, $final_path)) {
        // rename may fail across filesystem boundaries; fall back to copy+delete.
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_copy
        if (! copy($tmp_path, $final_path)) {
            @unlink($tmp_path);
            return new \WP_Error(
                'rest_server_error',
                sprintf(
                    'Could not overwrite the existing file at %s. Check filesystem permissions.',
                    esc_html($final_path)
                ),
                ['status' => 500]
            );
        }
        @unlink($tmp_path);
    }

    // --- 7. Update attachment metadata in the database -------------------------

    // Update the file path record (may be unchanged, but keeps DB consistent).
    update_attached_file($id, $final_path);

    // If MIME type has changed, update the attachment post's mime_type.
    $resolved_mime = $new_mime ?: get_post_mime_type($id);
    if ($resolved_mime && $resolved_mime !== get_post_mime_type($id)) {
        wp_update_post([
            'ID'             => $id,
            'post_mime_type' => sanitize_mime_type($resolved_mime),
        ]);
    }

    // Regenerate image metadata (sizes, dimensions, etc.).
    // These includes are needed outside of wp-admin context.
    require_once ABSPATH . 'wp-admin/includes/image.php';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';

    $new_meta = wp_generate_attachment_metadata($id, $final_path);
    if (is_wp_error($new_meta)) {
        // Non-fatal: metadata may not regenerate for non-image types.
        $new_meta = $old_meta ?: [];
    }
    wp_update_attachment_metadata($id, $new_meta);

    // --- 8. Build and return the updated attachment representation -------------

    // Fetch the fully updated attachment through the REST controller so the
    // response matches the standard WP media REST schema.
    $controller = new \WP_REST_Attachments_Controller('attachment');
    $attachment  = get_post($id);

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
 * Validates a file's type through three independent layers.
 *
 * Layer 1 — Explicit allowlist: rejects any MIME type not in the approved set.
 *   SVG is intentionally excluded: it can carry embedded JS/XSS and requires
 *   a dedicated sanitizer (e.g. enshrined/svg-sanitize) that is not bundled
 *   here. Add it back only if you bundle a sanitizer and run it before writing.
 *
 * Layer 2 — WordPress-native detection: wp_check_filetype_and_ext() uses the
 *   filename extension AND (where finfo/getimagesize is available) the actual
 *   file contents to independently determine the real MIME type. If WP detects
 *   a mismatch or rejects the type, the upload is refused.
 *
 * Layer 3 — Magic-byte check: reads the first N bytes and compares against
 *   known binary signatures for image and PDF types. Catches renamed executables
 *   that slipped past the previous layers (e.g. `evil.php` → `image.jpg`).
 *
 * @param string      $file_path  Absolute path to the temp file.
 * @param string      $filename   Original filename (used by wp_check_filetype_and_ext).
 * @param string|null $declared   Caller-declared MIME type (from Content-Type header or $_FILES).
 * @return true|\WP_Error
 */
function validate_file_type(string $file_path, string $filename, ?string $declared): true|\WP_Error
{
    // ------------------------------------------------------------------
    // Layer 1: Strict explicit allowlist.
    // Only MIME types listed here can be replaced via this endpoint.
    // Anything else — including SVG, text/html, application/x-php — is
    // immediately rejected before any bytes reach the filesystem.
    // ------------------------------------------------------------------
    $allowed_mimes = [
        'image/jpeg'        => true,
        'image/png'         => true,
        'image/gif'         => true,
        'image/webp'        => true,
        'application/pdf'   => true,
        'audio/mpeg'        => true,   // .mp3
        'audio/wav'         => true,
        'video/mp4'         => true,
        'application/msword' => true,  // .doc
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => true, // .docx
        'text/plain'        => true,
    ];

    $declared_clean = $declared ? sanitize_mime_type(strtolower(trim($declared))) : '';

    if (! isset($allowed_mimes[$declared_clean])) {
        return new \WP_Error(
            'rest_forbidden',
            sprintf(
                'MIME type "%s" is not permitted by this endpoint. Allowed types: %s.',
                esc_html($declared_clean ?: '(none)'),
                implode(', ', array_keys($allowed_mimes))
            ),
            ['status' => 415]
        );
    }

    // Also verify the declared MIME is in WordPress's per-user allowed set.
    // Administrators have a broader list; Editors may have fewer types enabled.
    $wp_allowed = get_allowed_mime_types();
    if (! in_array($declared_clean, $wp_allowed, true)) {
        return new \WP_Error(
            'rest_forbidden',
            sprintf('MIME type "%s" is not permitted for your user role.', esc_html($declared_clean)),
            ['status' => 415]
        );
    }

    // ------------------------------------------------------------------
    // Layer 2: WordPress-native filetype detection.
    // wp_check_filetype_and_ext() independently determines the real type
    // from the filename extension and (on capable hosts) file contents.
    // A return value of `type === false` means WP rejects the file.
    // ------------------------------------------------------------------

    // Include the function if not yet loaded (outside wp-admin context).
    if (! function_exists('wp_check_filetype_and_ext')) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
    }

    $wp_check = wp_check_filetype_and_ext($file_path, $filename, $wp_allowed);

    if (false === $wp_check['type']) {
        return new \WP_Error(
            'rest_forbidden',
            sprintf('WordPress rejected the file type for "%s". Upload refused.', esc_html($filename)),
            ['status' => 415]
        );
    }

    // If WP could detect a real MIME, verify it matches what was declared.
    if (! empty($wp_check['type']) && $wp_check['type'] !== $declared_clean) {
        return new \WP_Error(
            'rest_forbidden',
            sprintf(
                'Declared MIME type "%s" does not match detected type "%s". Upload refused.',
                esc_html($declared_clean),
                esc_html($wp_check['type'])
            ),
            ['status' => 415]
        );
    }

    // ------------------------------------------------------------------
    // Layer 3: Magic-byte validation for binary types.
    // Even after the above checks, confirm the file's leading bytes match
    // the expected signature. This catches edge cases where finfo is not
    // available and WP had to rely solely on the extension.
    // ------------------------------------------------------------------
    $signatures = [
        'image/jpeg'      => [0xFF, 0xD8, 0xFF],
        'image/png'       => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        'image/gif'       => [0x47, 0x49, 0x46, 0x38],   // GIF8
        'image/webp'      => [0x52, 0x49, 0x46, 0x46],   // RIFF header
        'application/pdf' => [0x25, 0x50, 0x44, 0x46],   // %PDF
    ];

    if (isset($signatures[$declared_clean])) {
        $expected = $signatures[$declared_clean];
        $needed   = count($expected);

        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
        $fh = fopen($file_path, 'rb');
        if (! $fh) {
            return new \WP_Error('rest_server_error', 'Could not open uploaded file for validation.', ['status' => 500]);
        }

        $header = fread($fh, $needed);
        fclose($fh);

        if (strlen($header) < $needed) {
            return new \WP_Error('rest_bad_request', 'Uploaded file is too small to validate.', ['status' => 400]);
        }

        $actual = array_values(unpack('C*', $header));
        foreach ($expected as $i => $byte) {
            if ($actual[$i] !== $byte) {
                return new \WP_Error(
                    'rest_forbidden',
                    sprintf(
                        'File content does not match declared MIME type "%s". Upload rejected.',
                        esc_html($declared_clean)
                    ),
                    ['status' => 415]
                );
            }
        }
    }

    return true;
}
