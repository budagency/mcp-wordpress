/**
 * Tests for ContentTools — wp_edit_post_content + wp_edit_page_content
 *
 * Mirrors the style of tests/tools/auth.test.js and tests/tools/pages.test.js.
 */
import { vi } from "vitest";
import { ContentTools } from "@/tools/content.js";

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------

function makeClient(overrides = {}) {
  return {
    getPost: vi.fn(),
    getPage: vi.fn(),
    updatePost: vi.fn().mockResolvedValue({ id: 1, content: { rendered: "" } }),
    updatePage: vi.fn().mockResolvedValue({ id: 1, content: { rendered: "" } }),
    restorePostRevision: vi.fn(),
    restorePageRevision: vi.fn(),
    getSiteUrl: vi.fn().mockReturnValue("https://test.example.com"),
    config: { baseUrl: "https://test.example.com", auth: { method: "app-password" } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getTools
// ---------------------------------------------------------------------------

describe("ContentTools.getTools", () => {
  it("returns exactly four tools with the correct names", () => {
    const ct = new ContentTools();
    const tools = ct.getTools();
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain("wp_edit_post_content");
    expect(names).toContain("wp_edit_page_content");
    expect(names).toContain("wp_restore_post_revision");
    expect(names).toContain("wp_restore_page_revision");
  });

  it("every tool has name, description, inputSchema, and handler", () => {
    const ct = new ContentTools();
    ct.getTools().forEach((tool) => {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    });
  });

  it("edit tools require id, find, and replace", () => {
    const ct = new ContentTools();
    const editTools = ct.getTools().filter((t) => t.name.startsWith("wp_edit_"));
    expect(editTools).toHaveLength(2);
    editTools.forEach((tool) => {
      expect(tool.inputSchema.required).toContain("id");
      expect(tool.inputSchema.required).toContain("find");
      expect(tool.inputSchema.required).toContain("replace");
    });
  });

  it("edit tools expose optional regex and count parameters", () => {
    const ct = new ContentTools();
    const editTools = ct.getTools().filter((t) => t.name.startsWith("wp_edit_"));
    editTools.forEach((tool) => {
      expect(tool.inputSchema.properties.regex).toBeDefined();
      expect(tool.inputSchema.properties.count).toBeDefined();
      expect(tool.inputSchema.properties.regex.type).toBe("boolean");
      expect(tool.inputSchema.properties.count.type).toBe("number");
    });
  });

  it("restore tools require their respective id fields and revision_id", () => {
    const ct = new ContentTools();
    const postRestore = ct.getTools().find((t) => t.name === "wp_restore_post_revision");
    const pageRestore = ct.getTools().find((t) => t.name === "wp_restore_page_revision");
    expect(postRestore.inputSchema.required).toContain("post_id");
    expect(postRestore.inputSchema.required).toContain("revision_id");
    expect(pageRestore.inputSchema.required).toContain("page_id");
    expect(pageRestore.inputSchema.required).toContain("revision_id");
  });
});

// ---------------------------------------------------------------------------
// wp_edit_post_content
// ---------------------------------------------------------------------------

describe("ContentTools.handleEditPostContent", () => {
  const POST_RAW = "Hello world. Hello again.";

  it("replaces all occurrences by default and updates the post", async () => {
    const client = makeClient({
      getPost: vi.fn().mockResolvedValue({ id: 42, content: { raw: POST_RAW, rendered: "" } }),
    });
    const ct = new ContentTools();

    const result = await ct.handleEditPostContent(client, { id: 42, find: "Hello", replace: "Hi" });

    expect(client.getPost).toHaveBeenCalledWith(42, "edit");
    expect(client.updatePost).toHaveBeenCalledWith({ id: 42, content: "Hi world. Hi again." });
    expect(result).toContain("✅ Post 42 content updated.");
    expect(result).toContain("Replacements made: 2");
  });

  it("replaces only N occurrences when count is provided", async () => {
    const client = makeClient({
      getPost: vi.fn().mockResolvedValue({ id: 5, content: { raw: POST_RAW, rendered: "" } }),
    });
    const ct = new ContentTools();

    await ct.handleEditPostContent(client, { id: 5, find: "Hello", replace: "Hi", count: 1 });

    expect(client.updatePost).toHaveBeenCalledWith({ id: 5, content: "Hi world. Hello again." });
  });

  it("throws a clear error when the find string is not found", async () => {
    const client = makeClient({
      getPost: vi.fn().mockResolvedValue({ id: 1, content: { raw: "Some content", rendered: "" } }),
    });
    const ct = new ContentTools();

    await expect(ct.handleEditPostContent(client, { id: 1, find: "MISSING_TEXT", replace: "x" })).rejects.toThrow(
      /Find string not found in post content/,
    );

    // updatePost must NOT have been called
    expect(client.updatePost).not.toHaveBeenCalled();
  });

  it("supports regex mode", async () => {
    const client = makeClient({
      getPost: vi.fn().mockResolvedValue({ id: 7, content: { raw: "2022 and 2023", rendered: "" } }),
    });
    const ct = new ContentTools();

    await ct.handleEditPostContent(client, { id: 7, find: "\\d{4}", replace: "YEAR", regex: true });

    expect(client.updatePost).toHaveBeenCalledWith({ id: 7, content: "YEAR and YEAR" });
  });

  it("throws on invalid regex", async () => {
    const client = makeClient({
      getPost: vi.fn().mockResolvedValue({ id: 1, content: { raw: "some text", rendered: "" } }),
    });
    const ct = new ContentTools();

    await expect(
      ct.handleEditPostContent(client, { id: 1, find: "[invalid(regex", replace: "x", regex: true }),
    ).rejects.toThrow(/Invalid regular expression/);
  });

  it("throws when raw content is unavailable (no context=edit support)", async () => {
    const client = makeClient({
      getPost: vi.fn().mockResolvedValue({ id: 3, content: { rendered: "<p>Hi</p>" } }),
    });
    const ct = new ContentTools();

    await expect(ct.handleEditPostContent(client, { id: 3, find: "Hi", replace: "Hello" })).rejects.toThrow(
      /Could not retrieve raw content for post/,
    );
  });

  it("throws when getPost fails", async () => {
    const client = makeClient({
      getPost: vi.fn().mockRejectedValue(new Error("404 Not Found")),
    });
    const ct = new ContentTools();

    await expect(ct.handleEditPostContent(client, { id: 999, find: "x", replace: "y" })).rejects.toThrow(
      /wp_edit_post_content failed/,
    );
  });

  it("throws when id is missing or invalid", async () => {
    const ct = new ContentTools();
    const client = makeClient();

    await expect(ct.handleEditPostContent(client, { find: "x", replace: "y" })).rejects.toThrow(
      /"id" must be a positive integer/,
    );
  });

  it("throws when find is missing", async () => {
    const ct = new ContentTools();
    const client = makeClient();

    await expect(ct.handleEditPostContent(client, { id: 1, replace: "y" })).rejects.toThrow(
      /"find" \(string\) is required/,
    );
  });

  it("throws when replace is missing", async () => {
    const ct = new ContentTools();
    const client = makeClient();

    await expect(ct.handleEditPostContent(client, { id: 1, find: "x" })).rejects.toThrow(
      /"replace" \(string\) is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// wp_edit_page_content
// ---------------------------------------------------------------------------

describe("ContentTools.handleEditPageContent", () => {
  const PAGE_RAW = "Welcome to our site. Welcome back.";

  it("replaces all occurrences and updates the page", async () => {
    const client = makeClient({
      getPage: vi.fn().mockResolvedValue({ id: 10, content: { raw: PAGE_RAW, rendered: "" } }),
    });
    const ct = new ContentTools();

    const result = await ct.handleEditPageContent(client, { id: 10, find: "Welcome", replace: "Hello" });

    expect(client.getPage).toHaveBeenCalledWith(10, "edit");
    expect(client.updatePage).toHaveBeenCalledWith({ id: 10, content: "Hello to our site. Hello back." });
    expect(result).toContain("✅ Page 10 content updated.");
    expect(result).toContain("Replacements made: 2");
  });

  it("replaces only first match with count=1", async () => {
    const client = makeClient({
      getPage: vi.fn().mockResolvedValue({ id: 10, content: { raw: PAGE_RAW, rendered: "" } }),
    });
    const ct = new ContentTools();

    await ct.handleEditPageContent(client, { id: 10, find: "Welcome", replace: "Hello", count: 1 });

    expect(client.updatePage).toHaveBeenCalledWith({ id: 10, content: "Hello to our site. Welcome back." });
  });

  it("throws a clear error when the find string is not found", async () => {
    const client = makeClient({
      getPage: vi.fn().mockResolvedValue({ id: 10, content: { raw: "Some content", rendered: "" } }),
    });
    const ct = new ContentTools();

    await expect(ct.handleEditPageContent(client, { id: 10, find: "MISSING_TEXT", replace: "x" })).rejects.toThrow(
      /Find string not found in page content/,
    );

    expect(client.updatePage).not.toHaveBeenCalled();
  });

  it("supports regex mode on pages", async () => {
    const client = makeClient({
      getPage: vi.fn().mockResolvedValue({ id: 11, content: { raw: "Price: $100 and $200", rendered: "" } }),
    });
    const ct = new ContentTools();

    await ct.handleEditPageContent(client, { id: 11, find: "\\$\\d+", replace: "PRICE", regex: true });

    expect(client.updatePage).toHaveBeenCalledWith({ id: 11, content: "Price: PRICE and PRICE" });
  });

  it("throws when raw content is unavailable", async () => {
    const client = makeClient({
      getPage: vi.fn().mockResolvedValue({ id: 10, content: { rendered: "<p>text</p>" } }),
    });
    const ct = new ContentTools();

    await expect(ct.handleEditPageContent(client, { id: 10, find: "text", replace: "copy" })).rejects.toThrow(
      /Could not retrieve raw content for page/,
    );
  });

  it("throws when getPage fails (e.g. 404)", async () => {
    const client = makeClient({
      getPage: vi.fn().mockRejectedValue(new Error("404 Not Found")),
    });
    const ct = new ContentTools();

    await expect(ct.handleEditPageContent(client, { id: 999, find: "x", replace: "y" })).rejects.toThrow(
      /wp_edit_page_content failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// wp_restore_post_revision
// ---------------------------------------------------------------------------

describe("ContentTools.handleRestorePostRevision", () => {
  const RESTORED_POST = {
    id: 42,
    status: "publish",
    modified: "2024-01-15T10:00:00",
    title: { rendered: "Restored Title" },
  };

  it("calls restorePostRevision with the correct ids and returns success message", async () => {
    const client = makeClient({
      restorePostRevision: vi.fn().mockResolvedValue(RESTORED_POST),
    });
    const ct = new ContentTools();

    const result = await ct.handleRestorePostRevision(client, { post_id: 42, revision_id: 7 });

    expect(client.restorePostRevision).toHaveBeenCalledWith(42, 7);
    expect(result).toContain("✅ Post 42 restored to revision 7");
    expect(result).toContain("Restored Title");
    expect(result).toContain("publish");
  });

  it("throws on invalid post_id", async () => {
    const ct = new ContentTools();
    const client = makeClient();

    await expect(ct.handleRestorePostRevision(client, { post_id: 0, revision_id: 1 })).rejects.toThrow(
      /"post_id" must be a positive integer/,
    );
  });

  it("throws on invalid revision_id", async () => {
    const ct = new ContentTools();
    const client = makeClient();

    await expect(ct.handleRestorePostRevision(client, { post_id: 1, revision_id: -1 })).rejects.toThrow(
      /"revision_id" must be a positive integer/,
    );
  });

  it("wraps client errors with a clear prefix", async () => {
    const client = makeClient({
      restorePostRevision: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
    });
    const ct = new ContentTools();

    await expect(ct.handleRestorePostRevision(client, { post_id: 1, revision_id: 2 })).rejects.toThrow(
      /wp_restore_post_revision failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// wp_restore_page_revision
// ---------------------------------------------------------------------------

describe("ContentTools.handleRestorePageRevision", () => {
  const RESTORED_PAGE = {
    id: 10,
    status: "publish",
    modified: "2024-02-20T08:30:00",
    title: { rendered: "About Us (restored)" },
  };

  it("calls restorePageRevision with the correct ids and returns success message", async () => {
    const client = makeClient({
      restorePageRevision: vi.fn().mockResolvedValue(RESTORED_PAGE),
    });
    const ct = new ContentTools();

    const result = await ct.handleRestorePageRevision(client, { page_id: 10, revision_id: 3 });

    expect(client.restorePageRevision).toHaveBeenCalledWith(10, 3);
    expect(result).toContain("✅ Page 10 restored to revision 3");
    expect(result).toContain("About Us (restored)");
  });

  it("throws on invalid page_id", async () => {
    const ct = new ContentTools();
    const client = makeClient();

    await expect(ct.handleRestorePageRevision(client, { page_id: 0, revision_id: 1 })).rejects.toThrow(
      /"page_id" must be a positive integer/,
    );
  });

  it("throws on invalid revision_id", async () => {
    const ct = new ContentTools();
    const client = makeClient();

    await expect(ct.handleRestorePageRevision(client, { page_id: 1, revision_id: 0 })).rejects.toThrow(
      /"revision_id" must be a positive integer/,
    );
  });

  it("wraps client errors with a clear prefix", async () => {
    const client = makeClient({
      restorePageRevision: vi.fn().mockRejectedValue(new Error("404 Revision not found")),
    });
    const ct = new ContentTools();

    await expect(ct.handleRestorePageRevision(client, { page_id: 5, revision_id: 99 })).rejects.toThrow(
      /wp_restore_page_revision failed/,
    );
  });
});
