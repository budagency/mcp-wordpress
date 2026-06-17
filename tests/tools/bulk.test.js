/**
 * Tests for BulkTools (src/tools/bulk.ts)
 *
 * Uses a 2-site mock clients map to verify:
 *   - per-site result aggregation (both ok and error paths)
 *   - write operations are blocked without confirm:true
 *   - unknown site IDs and operations are rejected cleanly
 */

import { vi } from "vitest";
import { BulkTools } from "@/tools/bulk.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeClient(overrides = {}) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

function makeClients(clientMap) {
  const map = new Map();
  for (const [id, client] of Object.entries(clientMap)) {
    map.set(id, client);
  }
  return map;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PLUGIN_A = [{ plugin: "akismet/akismet", name: "Akismet", status: "active", version: "5.3" }];
const PLUGIN_B = [];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BulkTools", () => {
  let clientA;
  let clientB;
  let twoSiteClients;
  let bulkTools;

  // Dummy client for handler signature — wp_bulk ignores the per-call client
  let dummyClient;

  beforeEach(() => {
    vi.clearAllMocks();

    clientA = makeClient({ get: vi.fn().mockResolvedValue(PLUGIN_A) });
    clientB = makeClient({ get: vi.fn().mockResolvedValue(PLUGIN_B) });

    twoSiteClients = makeClients({ siteA: clientA, siteB: clientB });
    bulkTools = new BulkTools(twoSiteClients);

    dummyClient = makeClient();
  });

  // ── getTools ──────────────────────────────────────────────────────────────

  describe("getTools", () => {
    it("should expose exactly one tool: wp_bulk", () => {
      const tools = bulkTools.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("wp_bulk");
    });

    it("should have a description, inputSchema, and handler", () => {
      const [tool] = bulkTools.getTools();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    });

    it("should declare 'sites' and 'operation' as required", () => {
      const [tool] = bulkTools.getTools();
      expect(tool.inputSchema.required).toContain("sites");
      expect(tool.inputSchema.required).toContain("operation");
    });
  });

  // ── Read-only fan-out ─────────────────────────────────────────────────────

  describe("read-only operations (no confirm needed)", () => {
    it("should fan wp_list_plugins across all sites and return per-site results", async () => {
      const [tool] = bulkTools.getTools();
      const results = await tool.handler(dummyClient, {
        sites: "all",
        operation: "wp_list_plugins",
      });

      expect(results).toHaveLength(2);

      const resultA = results.find((r) => r.site === "siteA");
      const resultB = results.find((r) => r.site === "siteB");

      expect(resultA.ok).toBe(true);
      expect(resultA.result.count).toBe(1);
      expect(resultA.result.plugins[0].plugin).toBe("akismet/akismet");

      expect(resultB.ok).toBe(true);
      expect(resultB.result.count).toBe(0);
    });

    it("should fan across a specific site when a single site ID is provided", async () => {
      const [tool] = bulkTools.getTools();
      const results = await tool.handler(dummyClient, {
        sites: "siteA",
        operation: "wp_list_plugins",
      });

      expect(results).toHaveLength(1);
      expect(results[0].site).toBe("siteA");
      expect(results[0].ok).toBe(true);

      // siteB client was NOT called
      expect(clientB.get).not.toHaveBeenCalled();
    });

    it("should fan across comma-separated site IDs", async () => {
      const [tool] = bulkTools.getTools();
      const results = await tool.handler(dummyClient, {
        sites: "siteA, siteB",
        operation: "wp_list_plugins",
      });

      expect(results).toHaveLength(2);
      expect(clientA.get).toHaveBeenCalled();
      expect(clientB.get).toHaveBeenCalled();
    });

    it("should aggregate per-site errors rather than throwing globally", async () => {
      clientA.get.mockRejectedValue(new Error("Site A is down"));

      const [tool] = bulkTools.getTools();
      const results = await tool.handler(dummyClient, {
        sites: "all",
        operation: "wp_list_plugins",
      });

      const resultA = results.find((r) => r.site === "siteA");
      const resultB = results.find((r) => r.site === "siteB");

      expect(resultA.ok).toBe(false);
      expect(resultA.error).toContain("Site A is down");

      expect(resultB.ok).toBe(true);
    });

    it("should NOT require confirm for wp_get_plugin (read-only)", async () => {
      clientA.get.mockResolvedValue({ plugin: "akismet/akismet", status: "active" });
      clientB.get.mockResolvedValue({ plugin: "akismet/akismet", status: "inactive" });

      const [tool] = bulkTools.getTools();
      // Should not throw — confirm is not provided
      const results = await tool.handler(dummyClient, {
        sites: "all",
        operation: "wp_get_plugin",
        params: { plugin: "akismet/akismet" },
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.ok)).toBe(true);
    });
  });

  // ── Write safety ──────────────────────────────────────────────────────────

  describe("write safety — confirm:true required", () => {
    it("should throw when confirm is absent on a write operation", async () => {
      const [tool] = bulkTools.getTools();

      await expect(
        tool.handler(dummyClient, {
          sites: "all",
          operation: "wp_activate_plugin",
          params: { plugin: "akismet/akismet" },
          // confirm: not provided
        }),
      ).rejects.toThrow(/write\/mutating operation/i);
    });

    it("should throw when confirm is false on a write operation", async () => {
      const [tool] = bulkTools.getTools();

      await expect(
        tool.handler(dummyClient, {
          sites: "all",
          operation: "wp_activate_plugin",
          params: { plugin: "akismet/akismet" },
          confirm: false,
        }),
      ).rejects.toThrow(/write\/mutating operation/i);
    });

    it("should execute a write operation when confirm:true is supplied", async () => {
      const activated = { plugin: "akismet/akismet", status: "active" };
      clientA.put.mockResolvedValue(activated);
      clientB.put.mockResolvedValue(activated);

      const [tool] = bulkTools.getTools();
      const results = await tool.handler(dummyClient, {
        sites: "all",
        operation: "wp_activate_plugin",
        params: { plugin: "akismet/akismet" },
        confirm: true,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(clientA.put).toHaveBeenCalled();
      expect(clientB.put).toHaveBeenCalled();
    });

    it("should require confirm for wp_deactivate_plugin", async () => {
      const [tool] = bulkTools.getTools();
      await expect(
        tool.handler(dummyClient, {
          sites: "siteA",
          operation: "wp_deactivate_plugin",
          params: { plugin: "akismet/akismet" },
        }),
      ).rejects.toThrow(/confirm:true/i);
    });

    it("should require confirm for wp_install_plugin", async () => {
      const [tool] = bulkTools.getTools();
      await expect(
        tool.handler(dummyClient, {
          sites: "siteA",
          operation: "wp_install_plugin",
          params: { slug: "contact-form-7" },
        }),
      ).rejects.toThrow(/confirm:true/i);
    });
  });

  // ── Input validation ──────────────────────────────────────────────────────

  describe("input validation", () => {
    it("should throw on unknown operation", async () => {
      const [tool] = bulkTools.getTools();
      await expect(
        tool.handler(dummyClient, {
          sites: "all",
          operation: "wp_nonexistent_tool",
        }),
      ).rejects.toThrow(/Unknown operation/i);
    });

    it("should throw on unknown site ID", async () => {
      const [tool] = bulkTools.getTools();
      await expect(
        tool.handler(dummyClient, {
          sites: "siteX",
          operation: "wp_list_plugins",
        }),
      ).rejects.toThrow(/Unknown site ID/i);
    });

    it("should throw when sites is an empty string", async () => {
      const [tool] = bulkTools.getTools();
      await expect(
        tool.handler(dummyClient, {
          sites: "",
          operation: "wp_list_plugins",
        }),
      ).rejects.toThrow();
    });

    it("should throw when operation is missing", async () => {
      const [tool] = bulkTools.getTools();
      await expect(
        tool.handler(dummyClient, {
          sites: "all",
        }),
      ).rejects.toThrow();
    });
  });

  // ── Per-site error aggregation ────────────────────────────────────────────

  describe("per-site error aggregation", () => {
    it("should return ok:false for a failing site and ok:true for a succeeding site", async () => {
      clientA.get.mockRejectedValue(new Error("Connection refused"));
      // clientB.get already returns PLUGIN_B = []

      const [tool] = bulkTools.getTools();
      const results = await tool.handler(dummyClient, {
        sites: "all",
        operation: "wp_list_plugins",
      });

      const a = results.find((r) => r.site === "siteA");
      const b = results.find((r) => r.site === "siteB");

      expect(a.ok).toBe(false);
      expect(a.error).toBeTruthy();
      expect(b.ok).toBe(true);
      expect(b.result).toBeDefined();
    });

    it("should strip the 'site' key from params before dispatching", async () => {
      // If the params object includes a 'site' key, it should be stripped
      clientA.get.mockResolvedValue(PLUGIN_A);

      const [tool] = bulkTools.getTools();
      const results = await tool.handler(dummyClient, {
        sites: "siteA",
        operation: "wp_list_plugins",
        params: { site: "some-other-site-that-would-be-wrong" },
      });

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
    });
  });
});
