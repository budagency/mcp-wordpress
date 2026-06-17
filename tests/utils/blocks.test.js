/**
 * Round-trip + structural tests for the Gutenberg block parse/serialize utility.
 *
 * These import the TypeScript source directly (vitest transforms it on the fly)
 * rather than dist/, so they run WITHOUT a build step — important because the
 * fork is being edited by concurrent agents and `npm run build` would race on dist/.
 * The module under test has no `@/` alias imports, so direct source import is safe.
 *
 * The core proof is round-trip stability: serializeBlocks(parseBlocks(x)) === x
 * for canonical WordPress markup (exactly what the REST API returns).
 */

import { describe, it, expect } from "vitest";
import { parseBlocks, serializeBlocks, serializeBlock, flattenBlocks } from "../../src/utils/blocks.ts";

const roundTrip = (markup) => serializeBlocks(parseBlocks(markup));

// ---------------------------------------------------------------------------
// Canonical WordPress fixtures (formatted exactly as the editor serializes them)
// ---------------------------------------------------------------------------

const PARAGRAPH = `<!-- wp:paragraph -->
<p>Hello world</p>
<!-- /wp:paragraph -->`;

const PARAGRAPH_WITH_ATTRS = `<!-- wp:paragraph {"align":"center","dropCap":false} -->
<p class="has-text-align-center">Centered</p>
<!-- /wp:paragraph -->`;

const TWO_TOP_LEVEL = `<!-- wp:heading -->
<h2 class="wp-block-heading">Title</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Body copy.</p>
<!-- /wp:paragraph -->`;

const NESTED_COLUMNS = `<!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph -->
<p>Left</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph -->
<p>Right</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->`;

const VOID_BLOCK = `<!-- wp:latest-posts {"postsToShow":3,"order":"desc"} /-->`;

const VOID_NO_ATTRS = `<!-- wp:page-list /-->`;

const CUSTOM_NAMESPACE = `<!-- wp:acf/testimonial {"name":"acf/testimonial","data":{"quote":"Great"},"mode":"preview"} -->
<div class="testimonial">Great</div>
<!-- /wp:acf/testimonial -->`;

const NESTED_ATTRS_JSON = `<!-- wp:group {"style":{"spacing":{"padding":{"top":"10px"}}}} -->
<div class="wp-block-group"><!-- wp:paragraph -->
<p>In a group</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->`;

const CLASSIC_HTML = `<p>This is classic editor content with no block delimiters.</p>`;

describe("parseBlocks / serializeBlocks — round trip", () => {
  const cases = {
    "simple paragraph": PARAGRAPH,
    "paragraph with attributes": PARAGRAPH_WITH_ATTRS,
    "two top-level blocks with inter-block whitespace": TWO_TOP_LEVEL,
    "nested columns/column/paragraph": NESTED_COLUMNS,
    "self-closing void block with attrs": VOID_BLOCK,
    "self-closing void block without attrs": VOID_NO_ATTRS,
    "custom namespace block (acf/)": CUSTOM_NAMESPACE,
    "nested attribute JSON containing braces": NESTED_ATTRS_JSON,
    "classic/freeform HTML (no blocks)": CLASSIC_HTML,
    "empty string": "",
  };

  for (const [name, markup] of Object.entries(cases)) {
    it(`is byte-stable for: ${name}`, () => {
      expect(roundTrip(markup)).toBe(markup);
    });
  }

  it("is idempotent on a full multi-block document", () => {
    const doc = `${TWO_TOP_LEVEL}\n\n${NESTED_COLUMNS}\n\n${VOID_BLOCK}`;
    const once = roundTrip(doc);
    const twice = roundTrip(once);
    expect(once).toBe(doc);
    expect(twice).toBe(once);
  });
});

describe("parseBlocks — structure", () => {
  it("returns top-level blocks with the canonical node shape", () => {
    const [block] = parseBlocks(PARAGRAPH);
    expect(block.blockName).toBe("core/paragraph");
    expect(block.attrs).toEqual({});
    expect(block.innerBlocks).toEqual([]);
    expect(block.innerHTML).toContain("<p>Hello world</p>");
    expect(Array.isArray(block.innerContent)).toBe(true);
  });

  it("normalizes core blocks to the core/ namespace", () => {
    const [block] = parseBlocks(PARAGRAPH);
    expect(block.blockName).toBe("core/paragraph"); // delimiter said `wp:paragraph`
  });

  it("parses attributes into an object", () => {
    const [block] = parseBlocks(PARAGRAPH_WITH_ATTRS);
    expect(block.attrs).toEqual({ align: "center", dropCap: false });
  });

  it("parses nested attribute JSON with inner braces", () => {
    const [block] = parseBlocks(NESTED_ATTRS_JSON);
    expect(block.attrs).toEqual({ style: { spacing: { padding: { top: "10px" } } } });
  });

  it("captures nesting depth for columns", () => {
    const [columns] = parseBlocks(NESTED_COLUMNS);
    expect(columns.blockName).toBe("core/columns");
    expect(columns.innerBlocks).toHaveLength(2);
    expect(columns.innerBlocks[0].blockName).toBe("core/column");
    expect(columns.innerBlocks[0].innerBlocks[0].blockName).toBe("core/paragraph");
  });

  it("marks self-closing void blocks with empty innerContent", () => {
    const [block] = parseBlocks(VOID_BLOCK);
    expect(block.blockName).toBe("core/latest-posts");
    expect(block.attrs).toEqual({ postsToShow: 3, order: "desc" });
    expect(block.innerContent).toEqual([]);
    expect(block.innerBlocks).toEqual([]);
  });

  it("represents classic content as a single freeform node", () => {
    const tree = parseBlocks(CLASSIC_HTML);
    expect(tree).toHaveLength(1);
    expect(tree[0].blockName).toBeNull();
    expect(tree[0].innerHTML).toBe(CLASSIC_HTML);
  });

  it("preserves a custom namespace (does not force core/)", () => {
    const [block] = parseBlocks(CUSTOM_NAMESPACE);
    expect(block.blockName).toBe("acf/testimonial");
  });
});

describe("serialize — explicit core/ namespace is canonicalized (idempotent)", () => {
  it("rewrites wp:core/paragraph to the short form and is stable thereafter", () => {
    const explicit = `<!-- wp:core/paragraph -->
<p>Hi</p>
<!-- /wp:core/paragraph -->`;
    const canonical = `<!-- wp:paragraph -->
<p>Hi</p>
<!-- /wp:paragraph -->`;
    const first = roundTrip(explicit);
    expect(first).toBe(canonical);
    expect(roundTrip(first)).toBe(first);
  });
});

describe("edit workflows on a parsed tree", () => {
  it("supports mutating an attribute then re-serializing", () => {
    const tree = parseBlocks(PARAGRAPH_WITH_ATTRS);
    tree[0].attrs.align = "left";
    const out = serializeBlocks(tree);
    expect(out).toContain('"align":"left"');
    expect(out).not.toContain('"align":"center"');
    // Re-parsing the edited output yields the new value.
    expect(parseBlocks(out)[0].attrs.align).toBe("left");
  });

  it("supports replacing inner HTML of a leaf block", () => {
    const tree = parseBlocks(PARAGRAPH);
    tree[0].innerHTML = "<p>Replaced</p>";
    tree[0].innerContent = ["<p>Replaced</p>"];
    expect(serializeBlock(tree[0])).toBe(`<!-- wp:paragraph --><p>Replaced</p><!-- /wp:paragraph -->`);
  });

  it("escapes HTML-comment-sensitive characters in attributes like WordPress does", () => {
    const node = {
      blockName: "core/html",
      attrs: { note: "a--b<c>d&e" },
      innerBlocks: [],
      innerHTML: "x",
      innerContent: ["x"],
    };
    const out = serializeBlock(node);
    expect(out).toContain("\\u002d\\u002d");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
    expect(out).toContain("\\u0026");
    // And it parses back to the original value.
    expect(parseBlocks(out)[0].attrs.note).toBe("a--b<c>d&e");
  });
});

describe("flattenBlocks", () => {
  it("flattens a nested tree depth-first", () => {
    const flat = flattenBlocks(parseBlocks(NESTED_COLUMNS));
    const names = flat.map((b) => b.blockName).filter(Boolean);
    expect(names).toEqual(["core/columns", "core/column", "core/paragraph", "core/column", "core/paragraph"]);
  });
});
