=== Bud Media Replace ===
Contributors:      budagency
Tags:              media, rest-api, headless, replace
Requires at least: 5.9
Tested up to:      6.7
Requires PHP:      8.0
License:           GPL-2.0-or-later
License URI:       https://www.gnu.org/licenses/gpl-2.0.html

Headless REST route to replace a media attachment binary in place,
keeping the same ID, filename, and all existing URLs.

== Description ==

Exposes a single capability-gated REST endpoint:

    POST /wp-json/bud/v1/media/<id>/replace

This lets the mcp-wordpress `wp_replace_media` tool overwrite the file
bytes of an existing attachment while keeping the attachment ID, original
filename, and all source URLs intact. WordPress core REST cannot do this
(PUT /wp/v2/media/<id> is metadata-only; re-upload creates a new ID).

The Enable Media Replace plugin (EMR) provides equivalent UI functionality
but has no headless / App-Password-compatible REST route. This plugin fills
that gap with a small, focused endpoint.

=== Request formats ===

Two formats are accepted:

1. **Multipart** (traditional form POST):
       Content-Type: multipart/form-data
       Field name:   file

2. **Raw binary** (preferred by the MCP tool):
       Content-Type:        image/jpeg          (or the correct MIME type)
       Content-Disposition: attachment; filename="badge.png"
       Body:                <raw bytes>

=== Scope ===

Images and PDFs only (`image/jpeg`, `image/png`, `image/gif`, `image/webp`,
`application/pdf`) — the types this endpoint can validate by content. The
replacement must be the SAME type as the original attachment (the filename and
URL are preserved, so a logo/badge/brochure swap is always same-type).

=== Security ===

- **Authorization (two layers):** `current_user_can('upload_files')` AND
  `current_user_can('edit_post', $id)` on the target attachment — App-Password
  (Basic Auth) compatible; blocks overwriting another user's media. NOT
  `is_user_logged_in()` (false for non-cookie sessions).
- **Uploads-dir confinement:** the destination directory is realpath-resolved and
  must live under the uploads basedir; symlinked attachments are refused, so a
  poisoned `_wp_attached_file` cannot become an arbitrary file write/delete.
- **Content-based type check:** the real type is detected from the bytes — via
  `finfo` (libmagic) when available, else by STRUCTURAL parsing (`getimagesize()`
  for images, `%PDF` header + `startxref`/`%%EOF` trailer for PDF). The client-
  declared MIME is never trusted, and the detected type must equal the original
  attachment's. `fileinfo` is preferred but no longer required (some CloudLinux/
  ea-php hosts omit it); the fallback is structural, not a byte-prefix match, so
  prefix-only polyglots (e.g. `GIF8<?php`) are rejected.
- **Strict allowlist + magic bytes:** only the five types above, each verified by
  its byte signature; `wp_check_filetype_and_ext()` cross-checks the extension.
- **Size cap:** the raw body is streamed to disk with a `wp_max_upload_size()`
  byte cap (no unbounded in-memory read); multipart size is checked too.
- **Atomic replace:** the new file is staged inside the validated target dir and
  swapped in with an atomic same-directory `rename()` (which replaces a symlink
  entry rather than following it) after a final TOCTOU re-check — `copy()` is
  never used on the destination path.

=== Residual considerations (by design / host-level) ===

- No application-level rate limiting — relies on the host/WAF plus the admin-only
  capability gate. Errors are opaque; 404-vs-403 attachment-ID enumeration is
  possible but low-value given the auth requirement.
- The web server MUST NOT execute PHP in wp-content/uploads/ — an image+PHP
  polyglot would pass type validation (identical to core WordPress upload risk).
- PDFs may carry JavaScript / embedded payloads (same as any WordPress PDF upload);
  a same-type PDF replacement is permitted by design.

=== File replacement sequence ===

1. Validate the attachment; detect the real type (`fileinfo`, else structural).
2. Confine to the uploads directory; reject symlinks.
3. Receive bytes ($_FILES, or a size-capped php://input stream).
4. Detect the real MIME with finfo; require it to equal the original.
5. Allowlist + extension + magic-byte validation.
6. Stage the new file in the target dir; atomic same-dir rename into place.
7. Delete the old size derivatives, full-size `original_image`, `thumb`, and
   `_wp_attachment_backup_sizes` (confined; never the new file).
8. `update_attached_file()` + `wp_generate_attachment_metadata()` + save.
9. Return `{ id, source_url, media_details, mime }`.

== Deployment & Activation ==

=== Supported sites ===

| Site     | Status    | Notes                                          |
|----------|-----------|------------------------------------------------|
| APWA     | Active    | PHP 8.2, LiteSpeed                             |
| iSeal    | Active    | PHP 8.1                                        |
| PDL      | Active    | PHP 8.2, LiteSpeed                             |
| GXR      | Active    | PHP 8.2, LiteSpeed                             |
| Bud      | DEFERRED  | PHP 7.4 (EOL) — activate after PHP 8.3 upgrade |
| TechBrain| Read-only | MCP is read-only; plugin not needed yet        |

=== Manual activation steps ===

1. Copy this folder (`bud-media-replace/`) into:
       /wp-content/plugins/bud-media-replace/

2. Activate in WP Admin → Plugins, OR via WP-CLI:
       wp plugin activate bud-media-replace

3. Verify the route is live:
       curl -s -u "username:app-password" \
         https://site.example.com/wp-json/bud/v1/media/123/replace \
         -X POST \
         --data-binary @/path/to/new-badge.png \
         -H "Content-Type: image/png" \
         -H "Content-Disposition: attachment; filename=\"badge.png\""

4. A `403` response means the application password user lacks `upload_files`
   capability. Grant the Editor or higher role.

=== LiteSpeed / Apache note ===

App-Password authentication requires the Authorization header to be passed
through to PHP. Add to .htaccess if 401s occur:

    RewriteCond %{HTTP:Authorization} ^(.*)
    RewriteRule .* - [e=HTTP_AUTHORIZATION:%1]

=== Must-Use (mu-plugin) deployment ===

To ensure the plugin cannot be accidentally deactivated, drop it into:
    /wp-content/mu-plugins/bud-media-replace/bud-media-replace.php

Note: mu-plugins cannot be activated/deactivated from the admin UI.

== Changelog ==

= 1.6.1 =
* Fix: PHP 8.0/8.1 compatibility. validate_file_type() declared a standalone `true`
  return type (`true|WP_Error`), which is only valid on PHP 8.2+ and caused a fatal
  parse error ("plugin triggered a fatal error" on activation) on 8.0/8.1 hosts.
  Changed to `bool|WP_Error` (returns true on success; callers use is_wp_error()).
  The plugin now genuinely matches its "Requires PHP: 8.0" header.

= 1.6.0 =
* fileinfo no longer hard-required (it is absent on some CloudLinux/ea-php hosts,
  which made the endpoint 500). Type detection now prefers fileinfo and falls back
  to STRUCTURAL parsing when it is missing: getimagesize() for images (parses real
  image structure, not a byte prefix) and a %PDF header + startxref/%%EOF trailer
  check for PDF. Prefix-only polyglots ("GIF8<?php", "%PDF<script>") are rejected
  on fileinfo-less hosts. Tightened the GIF magic signature (require the 87a/89a
  "a") and made mime_signatures() the single source for the Layer-3 byte check.
  Dual-reviewed (Codex gpt-5.5 + GLM-5.2): the fallback is confirmed no weaker than
  the fileinfo path (stricter for PDF, equivalent for images). The valid-image/PDF-
  with-embedded-PHP residual is unchanged and identical to core WordPress — keep
  PHP execution disabled in wp-content/uploads/ (see Residual considerations).

= 1.5.0 =
* Hardening (GLM/z.ai review): guard the cross-device copy() fallback against a
  swapped staging symlink; re-verify the destination is a regular file within
  uploads after the final rename (closes a staging-symlink TOCTOU that could turn
  the attachment URL into an arbitrary-file read); explicit path-containment in the
  artifact-cleanup closure; WebP magic now also checks the "WEBP" form-type at
  offset 8 (RIFF alone matches WAV/AVI); handler-level edit_post re-check.

= 1.4.0 =
* Security/privacy: on replace, also delete the full-size `original_image`,
  legacy `thumb`, and `_wp_attachment_backup_sizes` so an old copy is never left
  publicly reachable; store fresh (not stale) metadata if regeneration fails.

= 1.3.0 =
* Hardening (Codex review #2): stage + atomic same-directory rename (no copy onto
  the destination — closes a symlink-follow TOCTOU); detect the real MIME with
  finfo and require it to equal the original (client MIME no longer trusted);
  restrict the allowlist to images + PDF (every type magic-byte verified); fail
  closed without fileinfo; restore web-readable perms after rename.

= 1.2.0 =
* Hardening (Codex review #1): confine all file ops to the uploads dir + reject
  symlinks; `wp_delete_file_from_directory()` for size files; validate the final
  destination filename; `is_uploaded_file()` on the multipart path; stream the
  raw body with a size cap.

= 1.1.0 =
* Security: per-attachment ownership check (`edit_post`); strict MIME allowlist +
  WordPress-native detection in addition to magic bytes.

= 1.0.0 =
* Initial release.
* POST /wp-json/bud/v1/media/<id>/replace endpoint.
* Multipart and raw-binary body support.
* Magic-byte validation for JPEG, PNG, GIF, WebP, PDF.
* Stale-thumbnail cleanup before replace.
* In-place overwrite preserving original filename and URL.
