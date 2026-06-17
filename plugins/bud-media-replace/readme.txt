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

=== Security ===

- Permission callback: `current_user_can('upload_files')` — works with
  WordPress Application Passwords (Basic Auth). NOT `is_user_logged_in()`,
  which returns false for non-cookie sessions.
- Magic-byte validation rejects disguised uploads (e.g. PHP renamed .jpg).
- Sanitizes all filenames and MIME types with WordPress core functions.
- Does not allow path traversal; always writes to the existing attachment path.

=== File replacement sequence ===

1. Validate attachment ID is an `attachment` post type.
2. Accept file from $_FILES['file'] or raw php://input.
3. Validate magic bytes against declared MIME type.
4. Preserve the original filename — overwrite the existing file at its path.
5. Delete stale image-size derivatives (thumbnails etc.).
6. `update_attached_file($id, $path)` to refresh the DB record.
7. `wp_generate_attachment_metadata($id, $path)` to regenerate sizes.
8. `wp_update_attachment_metadata($id, $meta)` to save.
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

= 1.0.0 =
* Initial release.
* POST /wp-json/bud/v1/media/<id>/replace endpoint.
* Multipart and raw-binary body support.
* Magic-byte validation for JPEG, PNG, GIF, WebP, PDF.
* Stale-thumbnail cleanup before replace.
* In-place overwrite preserving original filename and URL.
