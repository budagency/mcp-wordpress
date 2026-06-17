# Bud Agency — mcp-wordpress fork expansion brief

This is the budagency fork of `docdyhr/mcp-wordpress` (MIT). It carries Bud-specific
fixes and tools that must survive upstream reinstalls. Branch: **`bud-main`** (our
deployed branch). `main` mirrors upstream for drift tracking via mcp-curator.

## Why this fork exists

The agency runs this MCP against a 6-site WordPress fleet. Improvements previously
lived as fragile local `dist/` patches wiped by any `npm` reinstall. Owning a
source-built fork makes them durable and lets us add agency-critical capabilities
(media replace, ACF/blocks, menus, plugins, bulk) the upstream lacks.

## Run model (how it's launched)

- Built from source: `npm install && npm run build` (`tsc && tsc-alias`). Node ≥ 20.8.1.
- Launched by `internal/internal-tools/wp-mcp-launch.py`, whose `PKG_DIR` now points
  at **this checkout** (`internal/mcp-wordpress`). It reads app passwords from
  `~/.claude/secrets.env`, generates `~/.claude/mcp-wordpress.config.json` (chmod 600),
  symlinks it into the checkout root, then `exec node dist/index.js`.
- Secrets live ONLY in secrets.env / Bitwarden. `mcp-wordpress.config.json` is a
  generated artifact and is git-ignored (line 143). Never commit it or `.env`.
- Takes effect on the next `cc` launch with the `wp` mode. A running session keeps
  the previously-launched server until restart — so new tools are NOT live in the
  session that builds them.

> ⚠️ Commit hooks: husky set repo-local `core.hooksPath=.husky/_`, which overrides
> the global gitleaks hook for THIS repo. Pre-commit runs lint-staged + lint +
> typecheck. Be deliberate: never `git add` a secret; the generated config is ignored.

## Tool-registration recipe (how to add a tool)

`src/server/ToolRegistry.ts` does `Object.values(Tools)` over the barrel
`src/tools/index.ts`, instantiates each class, and calls `getTools()`. So:

1. **Operations layer** — add the REST call to a class in `src/client/operations/*.ts`
   (or a new file). The client (`src/client/api.ts`) exposes `get/post/put/delete`
   with `(endpoint, data?, options?: RequestOptions)`; `getPost/getPage/getMediaItem`
   already accept `context: "view"|"embed"|"edit"`. The active request path
   (`RequestManager.ts`) passes `Buffer` bodies through with the caller's
   `Content-Type` (used by the media fix).
2. **Tool layer** — a class in `src/tools/*.ts` whose `getTools()` returns objects of
   `{ name, description, inputSchema, handler(client, params) }`. Tool names are
   `wp_*`. The registry converts Zod/JSON-schema for the `tools/list` response.
3. **Register** — add one `export { default as XTools } from "./x.js";` line to
   `src/tools/index.ts`. Auto-registered. (Tools needing the clients map — Cache,
   Performance, and our new **Bulk** — are special-cased in ToolRegistry to receive
   `wordpressClients` in their constructor; follow that pattern.)
4. Add vitest unit tests (mock the client) and run `npm run build && npm run typecheck`.

## Scope decisions (this session)

- **Media replace** → a **Bud-owned plugin** (modern PHP, 8.0+) exposing one
  capability-gated REST route; deployed to **APWA, iSeal, PDL, GXR**. **Bud activation
  deferred** until its PHP 8.3 / WP 7.0 upgrade (~2 weeks). EMR has no headless REST
  API (nonce-gated admin UI only); WP core REST cannot replace a binary in place
  (update = metadata only, re-upload = new ID). Verified by research, 2026-06-17.
- **Build scope**: foundation + confirmed gaps #1–5 + structural #7–10 + an ACF/blocks
  design spike & prototype (#6 not a full build this session).
- **Live tests**: write paths on APWA/iSeal/PDL/GXR via auto-cleaned scratch drafts +
  temp media; **TechBrain read-only**; Bud read/write OK but replace deferred. Validate
  LiteSpeed sites (GXR/Bud/PDL) with `wp_list_posts`, not `wp_test_auth`.

## Gap → workstream map

| # | Gap | Target files | Status |
|---|-----|--------------|--------|
| 1 | Media upload transport | `src/client/operations/media.ts` (+ defensive guard in `ComposedRequestManager.ts`) | ✅ done (P0) |
| 3 | Raw vs rendered content | `src/tools/posts.ts`, `pages.ts` (pass `context=edit`, surface `content.raw`) | P1A |
| 4 | Large-content partial edit | new `wp_edit_*_content` tool: fetch raw → find/replace → PUT | P1A |
| 5 | Auth health probe | `src/server/ConnectionTester.ts`, `src/tools/auth.ts` (probe `/settings` not `/users/me`) | P1A |
| 2 | In-place media replace | Bud plugin (`plugins/bud-media-replace/`) + `wp_replace_media` tool | P1B |
| 7 | Menus/widgets/settings | new ops + `src/tools/` classes (`/menus`, `/menu-items`, `/widgets`, `/settings`) | P2C |
| 9 | Revisions restore | new tool: re-PUT a revision's content to parent | P2C |
| 8 | Plugin/theme management | new ops + tools (`/plugins`, `/themes`) | P2D |
| 10 | Bulk / multi-site | new `BulkTools` (clients-map pattern) | P2D |
| 6 | ACF / blocks / reusable blocks | design doc + reusable-block (`wp_block`) + block parse/serialize prototype | P3 (spike) |
| 11 | Fork ownership | this fork + mcp-curator registration | ✅ done (P0) |
| 12 | Security stance | document app-password admin-only; capability-gate the replace route | ongoing |

## Bud media-replace plugin spec (`plugins/bud-media-replace/`)

- Single must-use/regular plugin, modern PHP.
- Route: `POST /wp-json/bud/v1/media/<id>/replace`, accepts the raw new file (binary
  body + Content-Type, or multipart).
- `permission_callback`: `current_user_can('upload_files')` — App-Password (Basic
  auth) compatible; NOT `is_user_logged_in()`.
- Body: replace the file at the existing attachment's path, keeping the ID and URL.
  Sequence (same as EMR internals): write temp → `wp_handle_sideload`/`wp_handle_upload`
  → `update_attached_file($id,$path)` → `wp_generate_attachment_metadata` →
  `wp_update_attachment_metadata`. Preserve the original filename so links keep working
  (this is the whole point — see the PDL badge case).
- `wp_replace_media` MCP tool uploads the new binary to this route per site.

## Gotchas

- Canonical URL must match the served host (a www↔apex redirect drops the Auth header).
- LiteSpeed (GXR/Bud/PDL) can 403 `/wp-json/wp/v2/users*` — don't gate health on it.
- Bud is on EOL PHP 7.4 until its imminent upgrade — don't activate the (8.0+) plugin
  there yet.
- Tools won't be live in the building session; test via vitest + a direct stdio spawn
  of `dist/index.js` + raw REST against sites.
