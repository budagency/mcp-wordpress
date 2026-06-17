# ACF / Blocks / Reusable Blocks — design spike (gap #6)

**Status:** spike (design + prototype). Scoped deliberately. See "What was NOT built" at the end.
**Branch:** `bud-main`. **Author:** ACF/blocks Lead.
**Prototype files:** `src/utils/blocks.ts`, `src/client/operations/blocks.ts`, `src/tools/blocks.ts` (non-wired), `tests/utils/blocks.test.js`.

## Why this matters

Most agency client sites are **ACF + a page builder (Elementor/Bricks) + Gutenberg**. Today the MCP can only
safely edit *plain* `post_content` HTML (posts/pages). That misses the three structural surfaces below. This doc
maps each surface to what is tractable over the WordPress REST API **without a headless browser**, and proposes a
phased build. The hard truth up front:

| Surface | Tractable via REST today? | Per-site prerequisite |
|---|---|---|
| (a) ACF field data | **Partial** — only if the site opts each field group into REST | Field group "Show in REST API" ON (or legacy plugin) |
| (b) Reusable blocks (`wp_block`) | **Yes, fully** — WordPress core route | None |
| (c) Block-structured `post_content` | **Yes** — parse/serialize in JS | None (Gutenberg sites only) |
| Page-builder layouts (Elementor/Bricks) | **No** (out of scope) | Stored as serialized meta / shortcodes, not block markup |

> **Page builders are explicitly out of scope.** Elementor stores its layout as serialized PHP/JSON in
> `_elementor_data` post meta; Bricks stores JSON in `_bricks_page_content_2`. Neither is Gutenberg block
> markup, so the block parser below does **not** touch them. Editing those safely is a separate, larger effort
> (structured meta editors per builder) and is not part of this spike.

---

## (a) ACF field data over REST

### How ACF exposes fields

ACF added **native** REST API support in **v5.11** (carried through ACF 6.x). It is **opt-in per field group**:
in the field group's **Group Settings → "Show in REST API"** toggle (off by default). When enabled, that group's
field values appear under a top-level **`acf`** key on the post/page/CPT REST object, alongside the standard fields.
([ACF: WP REST API Integration](https://www.advancedcustomfields.com/resources/wp-rest-api-integration/),
[ACF 5.11 release notes](https://www.advancedcustomfields.com/blog/acf-5-11-release-rest-api/))

```jsonc
// GET /wp/v2/pages/123?context=edit  (when the group is REST-enabled)
{
  "id": 123,
  "title": { "raw": "Home", "rendered": "Home" },
  "content": { "raw": "…", "rendered": "…" },
  "acf": {                       // ← present only if a field group opted in
    "hero_heading": "Welcome",
    "cta_url": "https://…",
    "testimonials": [ { "quote": "…", "author": "…" } ]
  }
}
```

### Detection (is ACF readable on this object?)

There is no global "ACF is installed" flag in core REST. The reliable, cheap probe is **presence-based**:

1. `GET /wp/v2/<type>/<id>?context=edit` and check whether the response has an **`acf`** key.
   - `acf` present and non-empty → at least one field group is REST-enabled for that type. **Read/write available.**
   - `acf` absent or `{}` → either ACF isn't installed, or **no field group opted into REST**. **Treat as "ACF not
     available via REST on this site"** and fall back (manual enablement, or the legacy plugin below).
2. Optionally confirm the plugin exists via `GET /wp/v2/plugins` (needs admin app password; LiteSpeed/security
   plugins may 403 this — don't gate on it).

This is necessarily a **runtime, per-site, per-post** check. We cannot know field schemas a priori.

### Read

Just read the `acf` object from the `context=edit` fetch (above). No extra request needed. Values are returned in a
mostly-usable shape (e.g. relationship/post-object fields return IDs or expanded objects depending on field config).

### Write

`POST` (or `PUT`/`PATCH`) the object with a partial **`acf`** object — only the keys you want to change:

```jsonc
// POST /wp/v2/pages/123
{ "acf": { "hero_heading": "Updated", "cta_url": null } }   // null deletes a field's value
```

Writes **require authentication** (our app-password Basic auth works). Field **names** (not field keys) are used
for the default native integration. ([ACF docs, as above](https://www.advancedcustomfields.com/resources/wp-rest-api-integration/))

### Known limitations (document these to the user)

- **Per-site, per-group opt-in.** Without "Show in REST API" we **cannot read or write ACF via REST at all** — no
  workaround short of (i) toggling it on (a Bud or client admin action in wp-admin / via the field group's PHP/JSON
  export), or (ii) installing the legacy plugin below.
- **Unsupported field types:** Message, Accordion, and Tab fields are **not** exposed in REST. Clone fields only
  appear when set to **Group** mode.
- **No schema discovery via core REST.** Field labels/types/validation live in field groups, which are not exposed
  by the native integration. Writes are "blind" — you must know the field name and an acceptable value shape.
- **Validation is server-side and silent-ish.** A bad value may be coerced or rejected; always read back after write.

### Legacy alternative — `acf-to-rest-api`

The third-party **[airesvsg/acf-to-rest-api](https://github.com/airesvsg/acf-to-rest-api)** plugin predates native
support and exposes ACF under its own structure (historically an `acf`/`fields` key, plus dedicated
`/acf/v3/...` routes), with filters like `acf/rest_api/key`. Use only on sites still on it or where native opt-in is
impractical; native ACF 6.x is preferred where available. Detection differs (look for `/acf/v3` routes or its key),
so a build should treat it as a separate adapter, not the default path.

---

## (b) Reusable blocks — the `wp_block` CPT  ✅ tractable now

Reusable blocks (renamed **"synced patterns"** in the editor UI since WP 6.3, but still the `wp_block` post type)
are a **core** WordPress feature exposed at REST base **`blocks`**:

**Route: `/wp/v2/blocks`** ([WP REST API reference — Editor Blocks](https://developer.wordpress.org/rest-api/reference/blocks/))

| Operation | Method | Endpoint |
|---|---|---|
| List | GET | `/wp/v2/blocks` |
| Get one | GET | `/wp/v2/blocks/<id>` |
| Create | POST | `/wp/v2/blocks` |
| Update | POST (PUT/PATCH alias) | `/wp/v2/blocks/<id>` |
| Delete | DELETE | `/wp/v2/blocks/<id>` |

Schema mirrors posts/pages: `id`, `title` (object), `content` (object, supports `raw` under `context=edit`),
`status`, `slug`, `date`, `meta`, `template`, plus read-only `link`/`guid`/`modified`. Contexts `view`/`embed`/`edit`.

This needs **no plugin** and is the highest-value, lowest-risk win: editing a single reusable block updates it
**everywhere it is embedded** across the site — ideal for agency-managed shared CTAs, footers, promo banners.
Implemented in `src/client/operations/blocks.ts` (`listBlocks`/`getBlock`/`createBlock`/`updateBlock`/`deleteBlock`,
mirroring `pages.ts`), with a non-wired tool prototype in `src/tools/blocks.ts`.

---

## (c) Block-structured content — Gutenberg delimited markup  ✅ tractable now

Gutenberg stores block content in `post_content` as HTML annotated with **block-delimiter HTML comments**:

```html
<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">Hello</p>
<!-- /wp:paragraph -->
```

Grammar ([WP block markup docs](https://developer.wordpress.org/block-editor/getting-started/fundamentals/markup-representation-block/)):
- **Opener:** `<!-- wp:<name> {<json attrs>} -->` (attrs optional).
- **Closer:** `<!-- /wp:<name> -->`.
- **Self-closing/void:** `<!-- wp:<name> /-->` (dynamic blocks with no saved inner HTML).
- **Core namespace omitted:** `wp:paragraph` ≡ `core/paragraph`; custom blocks are namespaced (`wp:acf/testimonial`).

This is **fully parseable/serializable in plain JS** — no headless browser, no `@wordpress/*` runtime dependency.
`src/utils/blocks.ts` is a faithful TypeScript port of the algorithm in
[`@wordpress/block-serialization-default-parser`](https://developer.wordpress.org/block-editor/reference-guides/packages/packages-block-serialization-default-parser/),
producing the canonical node shape so trees are interchangeable with the upstream package:

```ts
interface BlockNode {
  blockName: string | null;          // "core/paragraph" | "acf/testimonial" | null (freeform/whitespace)
  attrs: Record<string, unknown>;    // parsed JSON attributes ({} when none)
  innerBlocks: BlockNode[];          // nested children, in order
  innerHTML: string;                 // literal HTML chunks (excludes child markup)
  innerContent: Array<string | null>;// interleaving of HTML chunks (string) and child placeholders (null)
}
```

`innerContent` is what makes **nested round-tripping exact**: walking it and substituting each `null` with the next
`innerBlocks` entry reconstructs the original inner markup verbatim.

**Round-trip contract (proven in tests):** for canonical WordPress markup (what the REST API returns),
`serializeBlocks(parseBlocks(x)) === x` byte-for-byte. The one intentional normalization is that an explicit
`core/` namespace in a delimiter is rewritten to the short form WordPress itself emits
(`wp:core/paragraph` → `wp:paragraph`); the transform is **idempotent** thereafter. Attribute serialization matches
WordPress's `serializeAttributes()` escaping (`--`, `<`, `>`, `&`, `\"` → `\uXXXX`) so real-world content stays exact.

`tests/utils/blocks.test.js` — **24 tests, all passing** — covers: simple/attributed paragraphs, inter-block
whitespace, nested columns→column→paragraph, void blocks (with/without attrs), custom namespaces, nested attribute
JSON containing braces, classic/freeform HTML, the empty string, idempotency on a multi-block document, attribute
mutation + re-serialize workflows, the escaping behaviour, and `flattenBlocks`.

### Why this enables safe edits

The current `wp_edit_*_content` find/replace (gap #4) operates on a flat string and can corrupt block markup if a
replacement straddles a delimiter. With a parser, an agent can: locate a block by name/index, edit **its** `attrs`
or `innerHTML` in the tree, then `serializeBlocks` — a **structure-aware** edit that can't break the surrounding
markup. That is the core unlock for block-based pages.

---

## Phased follow-up BUILD plan

Ordered by value ÷ risk. Each phase is independently shippable.

### Phase B1 — Reusable blocks (wire the prototype)  ·  low risk, high value
- Add `BlocksOperations` to `WordPressClient` (delegate methods, like pages) in `src/client/api.ts`.
- Add `export { default as BlockTools } from "./blocks.js";` to `src/tools/index.ts` (auto-registers).
- Promote `src/tools/blocks.ts` from prototype to wired; add `tests/tools/blocks/` handler tests with a mocked client.
- Live-smoke on a scratch reusable block (create → get → update → delete) on a Gutenberg dev site.
- **Risk:** minimal — core route, mirrors existing pages flow. **Prereq:** none.

### Phase B2 — Structure-aware content editing  ·  low/med risk, high value
- New tool `wp_edit_block_content`: fetch `content.raw` (`context=edit`) → `parseBlocks` → apply a structured op
  (set attr on Nth block of type X / replace innerHTML of a matched block / insert/remove a block) → `serializeBlocks`
  → PUT. Ships the `wp_inspect_blocks` outline tool too (already prototyped).
- Guardrail: re-`parseBlocks` the serialized output and assert block count/names are sane before PUT; optionally
  diff against the original tree and refuse if an unrequested block changed.
- **Risk:** serializer fidelity (mitigated by the round-trip test suite) and dynamic blocks whose *rendered* output
  differs from saved markup (we only ever touch saved markup, so safe). **Prereq:** Gutenberg site.

### Phase B3 — ACF read + targeted write  ·  med risk, high value where enabled
- `wp_get_acf_fields` (read the `acf` object via `context=edit`, with the presence-based detection above) and
  `wp_update_acf_fields` (partial `acf` write, read-back verification).
- Detection helper returns a clear "ACF not exposed via REST on this site/post" message rather than a silent empty.
- Document the per-site enablement step for clients; optionally a `wp_check_acf_rest` diagnostic.
- **Risk:** per-site opt-in means **partial fleet coverage**; blind writes without schema. Mitigate with mandatory
  read-back and dry-run mode. **Prereq:** "Show in REST API" per group (or legacy plugin adapter).

### Phase B4 — ACF schema awareness / legacy adapter  ·  med risk, medium value (optional)
- If field schemas are needed (validation, enumerations), consider reading `acf-json` exports from the theme (not
  REST) or the local field-group config; and/or an adapter for `acf-to-rest-api` sites.
- **Risk/Prereq:** higher complexity; only pursue if B3 proves insufficient in practice.

### Cross-cutting risks
- **Auth/host:** canonical URL must match served host or the Auth header drops (existing gotcha). LiteSpeed sites
  (GXR/Bud/PDL) can 403 `/wp/v2/plugins` and `/users` — don't gate ACF/blocks detection on those.
- **No build in shared sessions:** prototype validated via `npx tsc --noEmit` + `npx vitest run` against TS source
  (test imports `src/`, not `dist/`), avoiding the concurrent-agent `dist/` race.

---

## Which client sites this unblocks

> Verify each site's editor/plugin stack against the live API before relying on these — per the agency rule to
> validate platform facts against the live platform, not memory. The matrix below is the **decision rule**, not a
> confirmed per-site audit.

- **(b) Reusable blocks & (c) block parsing/editing** unblock **every site whose pages are authored in Gutenberg**,
  immediately and with no prerequisite. Across the 6-site fleet (APWA, iSeal, PDL, GXR, TechBrain, Bud), any site on
  the block editor gains structure-aware content edits + shared-block management on Phase B1/B2.
- **(a) ACF** unblocks **only sites that (i) run ACF and (ii) have opted field groups into REST.** This is a
  per-site, per-group check — run the presence probe on a representative page first. Sites heavy on ACF flexible-
  content layouts are the biggest potential win *if* enabled.
- **Page-builder sites (Elementor/Bricks)** are **not** unblocked by this work — their layout data is not block
  markup. Flag these explicitly so we don't promise block editing where it can't apply.

---

## What was NOT built (and why)

- **No full ACF field-editing tool.** Per the spike scope, ACF is **design-only** here: native REST is per-site
  opt-in and schema-blind, so a robust build needs detection + dry-run + read-back (Phase B3), not a rushed tool.
- **The block tool class is NOT wired.** `src/tools/blocks.ts` is deliberately omitted from `src/tools/index.ts`
  and `ToolRegistry`, and `BlocksOperations` is not yet attached to `WordPressClient` — those edits touch files other
  agents own this session. Wiring is Phase B1.
- **No page-builder (Elementor/Bricks) support** — out of scope (different storage model; larger effort).
- **No live API calls in this spike** — reusable-block ops are unit-shaped against the client interface; live smoke
  tests are Phase B1/P4.
- **No edits to `posts.ts`, `pages.ts`, `src/tools/index.ts`, `ToolRegistry.ts`, or `operations/index.ts`** — new
  files only, to avoid conflicts with concurrent workstreams.

## Open questions for Tom

1. Which fleet sites use **ACF**, and are any field groups already **"Show in REST API"**-enabled? (Decides whether
   Phase B3 has any coverage without client-side admin changes.)
2. Are we comfortable toggling **"Show in REST API"** on client field groups ourselves where we hold admin, or should
   that be a client-approved change per site?
3. Which sites are **Gutenberg** vs **Elementor/Bricks**? (Confirms the real reach of Phases B1–B2.)
4. Priority call: ship **reusable blocks (B1)** first as the quick win, or go straight for **structure-aware content
   editing (B2)**? (Recommendation: B1 then B2 — B1 is near-zero-risk and immediately useful for shared CTAs/footers.)
