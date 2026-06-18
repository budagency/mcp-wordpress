/**
 * Tests for ACFFieldTools — wp_get_acf_fields + wp_edit_acf_field
 *
 * Fixtures mirror APWA's Flexible Content shape (layout[] -> blocks[] -> text_editor),
 * including an empty image field ("") to exercise the ''->null write coercion.
 * The mock client is STATEFUL: get() returns current state, put() updates it — so the
 * handler's read -> concurrency re-read -> write -> read-back flow is realistic.
 */
import { vi } from "vitest";
import { ACFFieldTools } from "@/tools/acf-fields.js";

const clone = (x) => JSON.parse(JSON.stringify(x));

function baseAcf() {
  return {
    layout: [
      {
        acf_fc_layout: "content",
        background_image: "", // empty image field -> must coerce to null on write
        overlay_color: "#00abed",
        blocks: [{ acf_fc_layout: "text", text_editor: "<h1>Old heading</h1>", top_border: false }],
      },
      {
        acf_fc_layout: "content",
        background_image: 786,
        blocks: [{ acf_fc_layout: "text", text_editor: "Second block" }],
      },
    ],
  };
}

function makeClient(acf = baseAcf(), modified = "2026-06-18T00:00:00") {
  const state = { id: 2291, modified, content: { raw: "" }, acf: clone(acf) };
  return {
    _state: state,
    get: vi.fn(async () => clone(state)),
    put: vi.fn(async (_ep, body) => {
      if (body && typeof body === "object" && "acf" in body) state.acf = clone(body.acf);
      return clone(state);
    }),
  };
}

describe("ACFFieldTools.getTools", () => {
  it("returns two tools with correct names and required fields", () => {
    const tools = new ACFFieldTools().getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["wp_edit_acf_field", "wp_get_acf_fields"]);
    const edit = tools.find((t) => t.name === "wp_edit_acf_field");
    expect(edit.inputSchema.required).toEqual(expect.arrayContaining(["id", "path"]));
  });
});

describe("wp_get_acf_fields", () => {
  it("lists non-empty leaves by dot-path, hides empty by default", async () => {
    const client = makeClient();
    const out = await new ACFFieldTools().handleGetAcfFields(client, { id: 2291 });
    expect(client.get).toHaveBeenCalledWith("pages/2291?context=edit");
    expect(out).toContain("`layout.0.blocks.0.text_editor` = <h1>Old heading</h1>");
    expect(out).toContain("`layout.0.overlay_color` = #00abed");
    expect(out).toContain("`layout.1.background_image` = 786");
    expect(out).not.toContain("layout.0.background_image"); // empty -> hidden
  });

  it("includes empty fields when include_empty=true", async () => {
    const out = await new ACFFieldTools().handleGetAcfFields(makeClient(), { id: 2291, include_empty: true });
    expect(out).toContain("layout.0.background_image");
  });

  it("limits output to a subtree via path", async () => {
    const out = await new ACFFieldTools().handleGetAcfFields(makeClient(), { id: 2291, path: "layout.1" });
    expect(out).toContain("layout.1.background_image");
    expect(out).not.toContain("layout.0.overlay_color");
  });

  it("excludes the acf_fc_layout structural marker from the listing", async () => {
    const out = await new ACFFieldTools().handleGetAcfFields(makeClient(), { id: 2291, include_empty: true });
    expect(out).not.toContain("acf_fc_layout");
  });

  it("errors when no acf is exposed", async () => {
    const client = { get: vi.fn(async () => ({ id: 2291, content: { raw: "" } })) };
    await expect(new ACFFieldTools().handleGetAcfFields(client, { id: 2291 })).rejects.toThrow(
      /No ACF fields are exposed/,
    );
  });

  it("uses the posts endpoint for post_type=post", async () => {
    const client = makeClient();
    await new ACFFieldTools().handleGetAcfFields(client, { id: 2291, post_type: "post" });
    expect(client.get).toHaveBeenCalledWith("posts/2291?context=edit");
  });
});

describe("wp_edit_acf_field (write)", () => {
  it("edits a leaf and PUTs the acf object with '' coerced to null", async () => {
    const client = makeClient();
    const out = await new ACFFieldTools().handleEditAcfField(client, {
      id: 2291,
      path: "layout.0.blocks.0.text_editor",
      value: "<h1>New heading</h1>",
    });
    expect(client.put).toHaveBeenCalledTimes(1);
    const [ep, body] = client.put.mock.calls[0];
    expect(ep).toBe("pages/2291");
    expect(body.acf.layout[0].blocks[0].text_editor).toBe("<h1>New heading</h1>");
    // empty image field coerced to null for the write
    expect(body.acf.layout[0].background_image).toBeNull();
    // untouched non-empty fields preserved
    expect(body.acf.layout[1].background_image).toBe(786);
    expect(out).toContain('✅ Updated "layout.0.blocks.0.text_editor"');
  });

  it("accepts structured values via value_json", async () => {
    const client = makeClient();
    await new ACFFieldTools().handleEditAcfField(client, {
      id: 2291,
      path: "layout.1.background_image",
      value_json: "1024",
    });
    expect(client.put.mock.calls[0][1].acf.layout[1].background_image).toBe(1024);
  });

  it("dry_run does not write", async () => {
    const client = makeClient();
    const out = await new ACFFieldTools().handleEditAcfField(client, {
      id: 2291,
      path: "layout.0.blocks.0.text_editor",
      value: "x",
      dry_run: true,
    });
    expect(client.put).not.toHaveBeenCalled();
    expect(out).toContain("Dry run");
  });

  it("no-ops when the value is unchanged", async () => {
    const client = makeClient();
    const out = await new ACFFieldTools().handleEditAcfField(client, {
      id: 2291,
      path: "layout.1.background_image",
      value_json: "786",
    });
    expect(client.put).not.toHaveBeenCalled();
    expect(out).toContain("No change made");
  });
});

describe("wp_edit_acf_field (guardrails)", () => {
  const tool = () => new ACFFieldTools();

  it("errors when the path does not exist", async () => {
    const client = makeClient();
    await expect(tool().handleEditAcfField(client, { id: 2291, path: "layout.5.nope", value: "x" })).rejects.toThrow(
      /not found/,
    );
    expect(client.put).not.toHaveBeenCalled();
  });

  it("refuses to edit the acf_fc_layout structural marker", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.0.acf_fc_layout", value: "hero" }),
    ).rejects.toThrow(/structural marker/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("rejects prototype-pollution path segments", async () => {
    const client = makeClient();
    for (const p of ["__proto__.toString", "constructor.prototype.x", "layout.0.__proto__.y"]) {
      await expect(tool().handleEditAcfField(client, { id: 2291, path: p, value: "x" })).rejects.toThrow(
        /unsafe path segment/,
      );
    }
    expect(client.put).not.toHaveBeenCalled();
  });

  it("rejects array-method/length writes (canonical indices only)", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.length", value_json: "0" }),
    ).rejects.toThrow(/not found/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("rejects a container (object/array) new value", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.0.overlay_color", value_json: '{"a":1}' }),
    ).rejects.toThrow(/JSON scalar/);
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.0.overlay_color", value_json: "[1,2]" }),
    ).rejects.toThrow(/JSON scalar/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("rejects malformed paths (empty segments)", async () => {
    const client = makeClient();
    for (const p of ["layout..0", ".layout.0", "layout.0."]) {
      await expect(tool().handleEditAcfField(client, { id: 2291, path: p, value: "x" })).rejects.toThrow(
        /empty segment/,
      );
    }
    expect(client.put).not.toHaveBeenCalled();
  });

  it("refuses to edit a container (non-leaf) path", async () => {
    const client = makeClient();
    await expect(tool().handleEditAcfField(client, { id: 2291, path: "layout.0.blocks", value: "x" })).rejects.toThrow(
      /points to a list/,
    );
    expect(client.put).not.toHaveBeenCalled();
  });

  it("aborts on concurrent modification", async () => {
    const client = makeClient();
    // First read modified=t0, concurrency re-read modified=t1.
    client.get = vi
      .fn()
      .mockResolvedValueOnce({ id: 2291, modified: "t0", acf: baseAcf() })
      .mockResolvedValueOnce({ id: 2291, modified: "t1", acf: baseAcf() });
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.0.overlay_color", value: "#fff" }),
    ).rejects.toThrow(/changed after it was read/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it("fails loudly when the write does not persist", async () => {
    const client = makeClient();
    client.put = vi.fn(async () => ({})); // accept but do NOT update state
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.0.overlay_color", value: "#ffffff" }),
    ).rejects.toThrow(/did not persist/);
  });

  it("requires exactly one of value / value_json", async () => {
    const client = makeClient();
    await expect(tool().handleEditAcfField(client, { id: 2291, path: "layout.0.overlay_color" })).rejects.toThrow(
      /One of value/,
    );
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.0.overlay_color", value: "a", value_json: '"b"' }),
    ).rejects.toThrow(/only one of value or value_json/);
  });

  it("rejects a non-string value", async () => {
    const client = makeClient();
    await expect(
      tool().handleEditAcfField(client, { id: 2291, path: "layout.0.overlay_color", value: 123 }),
    ).rejects.toThrow(/"value" must be a string/);
  });

  it("rejects an invalid id", async () => {
    await expect(
      tool().handleEditAcfField(makeClient(), { id: 0, path: "layout.0.overlay_color", value: "x" }),
    ).rejects.toThrow(/"id" must be a positive integer/);
  });
});
