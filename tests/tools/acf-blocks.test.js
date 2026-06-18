/**
 * Tests for ACFBlockTools — wp_get_acf_blocks + wp_edit_acf_block
 *
 * Fixtures mirror real PDL/GXR markup: void acf/* blocks whose field values live
 * in attrs.data (each with an ACF `_field` key pointer), interleaved with core
 * blocks and inter-block whitespace. Mock style follows tests/tools/content.test.js.
 *
 * The mock updatePage/updatePost echo the written content back as content.raw, so
 * the tool's post-write read-back gate sees what it sent (the happy path); tests
 * that exercise concurrency/persistence failures override that per-case.
 */
import { vi } from "vitest";
import { ACFBlockTools } from "@/tools/acf-blocks.js";
import { parseBlocks, serializeBlocks } from "@/utils/blocks.js";

// ---------------------------------------------------------------------------
// Fixtures (canonical WordPress markup — round-trips byte-for-byte)
// ---------------------------------------------------------------------------

const HERO0 =
  '<!-- wp:acf/hero {"name":"acf/hero","data":{"title":"Old Title","_title":"field_abc","subtitle":"Sub","_subtitle":"field_def"},"mode":"preview"} /-->';
const PARA = "\n\n<!-- wp:paragraph -->\n<p>Hello world</p>\n<!-- /wp:paragraph -->\n\n";
const HERO1 =
  '<!-- wp:acf/hero {"name":"acf/hero","data":{"title":"Second Hero","_title":"field_abc"},"mode":"preview"} /-->';
const FAQ =
  '\n\n<!-- wp:acf/faq {"name":"acf/faq","data":{"question":"Why?","_question":"field_q","answer":"Because.","_answer":"field_a"},"mode":"edit"} /-->';

const PAGE_RAW = HERO0 + PARA + HERO1 + FAQ;

function makeClient(raw = PAGE_RAW, overrides = {}) {
  // updatePage/updatePost echo the content back as content.raw (server accepted it verbatim).
  // Each gets its OWN spy so post-type routing can be asserted independently.
  const echo = () => vi.fn(async ({ id, content }) => ({ id, content: { raw: content, rendered: "" } }));
  return {
    getPage: vi.fn().mockResolvedValue({ id: 10, modified: "2026-06-18T00:00:00", content: { raw, rendered: "" } }),
    getPost: vi.fn().mockResolvedValue({ id: 20, modified: "2026-06-18T00:00:00", content: { raw, rendered: "" } }),
    updatePage: echo(),
    updatePost: echo(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

describe("fixture byte-stability", () => {
  it("PAGE_RAW round-trips through parse/serialize byte-for-byte", () => {
    expect(serializeBlocks(parseBlocks(PAGE_RAW))).toBe(PAGE_RAW);
  });
});

// ---------------------------------------------------------------------------
// getTools
// ---------------------------------------------------------------------------

describe("ACFBlockTools.getTools", () => {
  it("returns two tools with the correct names and shape", () => {
    const tools = new ACFBlockTools().getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["wp_edit_acf_block", "wp_get_acf_blocks"]);
    tools.forEach((t) => {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.handler).toBe("function");
    });
  });

  it("wp_edit_acf_block requires id, block_name, field", () => {
    const tool = new ACFBlockTools().getTools().find((t) => t.name === "wp_edit_acf_block");
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["id", "block_name", "field"]));
  });
});

// ---------------------------------------------------------------------------
// wp_get_acf_blocks
// ---------------------------------------------------------------------------

describe("wp_get_acf_blocks", () => {
  it("enumerates acf/* blocks with occurrences and editable fields", async () => {
    const client = makeClient();
    const out = await new ACFBlockTools().handleGetAcfBlocks(client, { id: 10 });
    expect(client.getPage).toHaveBeenCalledWith(10, "edit");
    expect(out).toContain("acf/hero  (occurrence 0)");
    expect(out).toContain("acf/hero  (occurrence 1)");
    expect(out).toContain("acf/faq  (occurrence 0)");
    expect(out).toContain("**title**: Old Title");
    expect(out).toContain("**question**: Why?");
  });

  it("hides underscore field-key pointers but annotates the key", async () => {
    const out = await new ACFBlockTools().handleGetAcfBlocks(makeClient(), { id: 10 });
    expect(out).not.toContain("**_title**");
    expect(out).toContain("key: field_abc");
  });

  it("respects the block_name filter", async () => {
    const out = await new ACFBlockTools().handleGetAcfBlocks(makeClient(), { id: 10, block_name: "acf/faq" });
    expect(out).toContain("acf/faq");
    expect(out).not.toContain("acf/hero");
  });

  it("only lists fields that have a `_field` key pointer", async () => {
    const RAW = '<!-- wp:acf/mix {"name":"acf/mix","data":{"real":"a","_real":"field_x","junk":"b"}} /-->';
    const out = await new ACFBlockTools().handleGetAcfBlocks(makeClient(RAW), { id: 10 });
    expect(out).toContain("**real**");
    expect(out).not.toContain("**junk**");
  });

  it("reports cleanly when no ACF blocks exist", async () => {
    const client = makeClient("<!-- wp:paragraph -->\n<p>plain</p>\n<!-- /wp:paragraph -->");
    const out = await new ACFBlockTools().handleGetAcfBlocks(client, { id: 10 });
    expect(out).toContain("No ACF blocks found");
  });

  it("works against posts via post_type=post", async () => {
    const client = makeClient();
    await new ACFBlockTools().handleGetAcfBlocks(client, { id: 20, post_type: "post" });
    expect(client.getPost).toHaveBeenCalledWith(20, "edit");
  });
});

// ---------------------------------------------------------------------------
// wp_edit_acf_block — happy paths
// ---------------------------------------------------------------------------

describe("wp_edit_acf_block (write)", () => {
  it("edits one field and writes content that differs by exactly that value", async () => {
    const client = makeClient();
    const out = await new ACFBlockTools().handleEditAcfBlock(client, {
      id: 10,
      block_name: "acf/hero",
      occurrence: 0,
      field: "title",
      value: "New Title",
    });
    expect(client.updatePage).toHaveBeenCalledTimes(1);
    const written = client.updatePage.mock.calls[0][0];
    expect(written.id).toBe(10);
    expect(written.content).toBe(PAGE_RAW.replace("Old Title", "New Title"));
    expect(out).toContain("✅ Updated `acf/hero` (occurrence 0)");
    expect(out).toContain("New: New Title");
  });

  it("does not require occurrence when the block name is unique", async () => {
    const client = makeClient();
    await new ACFBlockTools().handleEditAcfBlock(client, {
      id: 10,
      block_name: "acf/faq",
      field: "answer",
      value: "Updated answer.",
    });
    const written = client.updatePage.mock.calls[0][0];
    expect(written.content).toBe(PAGE_RAW.replace("Because.", "Updated answer."));
  });

  it("targets the correct occurrence", async () => {
    const client = makeClient();
    await new ACFBlockTools().handleEditAcfBlock(client, {
      id: 10,
      block_name: "acf/hero",
      occurrence: 1,
      field: "title",
      value: "Edited Second",
    });
    const written = client.updatePage.mock.calls[0][0];
    expect(written.content).toBe(PAGE_RAW.replace("Second Hero", "Edited Second"));
    expect(written.content).toContain("Old Title");
  });

  it("accepts structured values via value_json", async () => {
    const RAW = '<!-- wp:acf/logos {"name":"acf/logos","data":{"logos":[1,2],"_logos":"field_l"}} /-->';
    const client = makeClient(RAW);
    await new ACFBlockTools().handleEditAcfBlock(client, {
      id: 10,
      block_name: "acf/logos",
      field: "logos",
      value_json: "[473,2250,2256]",
    });
    const written = client.updatePage.mock.calls[0][0];
    expect(written.content).toBe(RAW.replace("[1,2]", "[473,2250,2256]"));
  });

  it("supports posts via post_type=post", async () => {
    const client = makeClient();
    await new ACFBlockTools().handleEditAcfBlock(client, {
      id: 20,
      post_type: "post",
      block_name: "acf/faq",
      field: "answer",
      value: "Updated answer.",
    });
    expect(client.getPost).toHaveBeenCalledWith(20, "edit");
    expect(client.updatePost).toHaveBeenCalledTimes(1);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("dry_run validates without writing", async () => {
    const client = makeClient();
    const out = await new ACFBlockTools().handleEditAcfBlock(client, {
      id: 10,
      block_name: "acf/hero",
      occurrence: 0,
      field: "title",
      value: "Preview Only",
      dry_run: true,
    });
    expect(client.updatePage).not.toHaveBeenCalled();
    expect(out).toContain("Dry run");
    expect(out).toContain("Preview Only");
  });

  it("no-ops when the value already matches", async () => {
    const client = makeClient();
    const out = await new ACFBlockTools().handleEditAcfBlock(client, {
      id: 10,
      block_name: "acf/hero",
      occurrence: 0,
      field: "title",
      value: "Old Title",
    });
    expect(client.updatePage).not.toHaveBeenCalled();
    expect(out).toContain("No change made");
  });
});

// ---------------------------------------------------------------------------
// wp_edit_acf_block — guardrails
// ---------------------------------------------------------------------------

describe("wp_edit_acf_block (guardrails)", () => {
  const tool = () => new ACFBlockTools();

  it("requires occurrence when several blocks share a name", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/hero", field: "title", value: "y" }),
    ).rejects.toThrow(/Ambiguous: found 2/);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("aborts (no write) when content does not round-trip byte-for-byte", async () => {
    const RAW =
      "<!-- wp:core/paragraph -->\n<p>x</p>\n<!-- /wp:core/paragraph -->\n\n" +
      '<!-- wp:acf/hero {"name":"acf/hero","data":{"title":"T","_title":"field_abc"}} /-->';
    const client = makeClient(RAW);
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/hero", field: "title", value: "Y" }),
    ).rejects.toThrow(/does not round-trip byte-for-byte/);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("aborts when the page changed since it was read (concurrency)", async () => {
    const client = makeClient();
    client.getPage = vi
      .fn()
      .mockResolvedValueOnce({ id: 10, modified: "t0", content: { raw: PAGE_RAW } })
      .mockResolvedValueOnce({ id: 10, modified: "t1", content: { raw: PAGE_RAW.replace("Old Title", "Sneaky") } });
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/hero", occurrence: 0, field: "title", value: "Y" }),
    ).rejects.toThrow(/changed after it was read/);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("fails loudly when the write does not persist (KSES/filter mangling)", async () => {
    const client = makeClient();
    // Server accepts the request but returns the ORIGINAL content (field stripped).
    client.updatePage = vi.fn().mockResolvedValue({ id: 10, content: { raw: PAGE_RAW } });
    await expect(
      tool().handleEditAcfBlock(client, {
        id: 10,
        block_name: "acf/hero",
        occurrence: 0,
        field: "title",
        value: "New Title",
      }),
    ).rejects.toThrow(/did not persist/);
  });

  it("errors and does not write when the block is not found", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/missing", field: "x", value: "y" }),
    ).rejects.toThrow(/not found/);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("errors when the occurrence is out of range", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/hero", occurrence: 5, field: "title", value: "y" }),
    ).rejects.toThrow(/occurrence 5 not found/);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("errors and lists fields when the field is not found", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/faq", field: "nope", value: "y" }),
    ).rejects.toThrow(/"nope" not found/);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("refuses a field with no ACF `_field` key pointer", async () => {
    const RAW = '<!-- wp:acf/mix {"name":"acf/mix","data":{"real":"a","_real":"field_x","junk":"b"}} /-->';
    const client = makeClient(RAW);
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/mix", field: "junk", value: "y" }),
    ).rejects.toThrow(/not an editable ACF field/);
    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("refuses underscore field-key pointers", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/hero", occurrence: 0, field: "_title", value: "y" }),
    ).rejects.toThrow(/field-key pointers/);
  });

  it("rejects a non-ACF block name", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "core/paragraph", field: "x", value: "y" }),
    ).rejects.toThrow(/must be an ACF block/);
  });

  it("requires exactly one of value / value_json", async () => {
    const client = makeClient();
    await expect(tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/faq", field: "answer" })).rejects.toThrow(
      /One of value/,
    );
    await expect(
      tool().handleEditAcfBlock(client, {
        id: 10,
        block_name: "acf/faq",
        field: "answer",
        value: "a",
        value_json: '"b"',
      }),
    ).rejects.toThrow(/only one of value or value_json/);
  });

  it("gives a clear error when value is a non-string", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/faq", field: "answer", value: 123 }),
    ).rejects.toThrow(/"value" must be a string/);
  });

  it("errors on invalid value_json", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/faq", field: "answer", value_json: "{not json" }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("errors when raw content is unavailable", async () => {
    const client = makeClient(PAGE_RAW, {
      getPage: vi.fn().mockResolvedValue({ id: 10, content: { rendered: "<p>x</p>" } }),
    });
    await expect(
      tool().handleEditAcfBlock(client, { id: 10, block_name: "acf/faq", field: "answer", value: "y" }),
    ).rejects.toThrow(/Could not retrieve raw content/);
  });

  it("rejects an invalid id", async () => {
    await expect(
      tool().handleEditAcfBlock(makeClient(), { id: 0, block_name: "acf/faq", field: "answer", value: "y" }),
    ).rejects.toThrow(/"id" must be a positive integer/);
  });
});
