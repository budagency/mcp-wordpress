/**
 * Tests for PluginTools (src/tools/plugins.ts)
 * Mocks the WordPress client to avoid real HTTP calls.
 */

import { vi } from "vitest";
import { PluginTools } from "@/tools/plugins.js";

describe("PluginTools", () => {
  let pluginTools;
  let mockClient;

  const MOCK_PLUGINS = [
    {
      plugin: "akismet/akismet",
      name: "Akismet Anti-Spam",
      status: "active",
      version: "5.3",
      author: "Automattic",
      requires_wp: "5.8",
      requires_php: "7.2",
      network_only: false,
      description: { rendered: "Anti-spam", raw: "Anti-spam" },
    },
    {
      plugin: "hello-dolly/hello",
      name: "Hello Dolly",
      status: "inactive",
      version: "1.7.2",
      author: "Matt Mullenweg",
    },
  ];

  const MOCK_THEMES = [
    {
      stylesheet: "twentytwentythree",
      template: "twentytwentythree",
      status: "active",
      name: { rendered: "Twenty Twenty-Three", raw: "Twenty Twenty-Three" },
      version: "1.3",
      author: { rendered: "WordPress.org", raw: "WordPress.org" },
      requires_wp: "6.1",
      requires_php: "5.6",
    },
    {
      stylesheet: "astra",
      template: "astra",
      status: "inactive",
      name: { rendered: "Astra", raw: "Astra" },
      version: "4.0.0",
      author: { rendered: "Brainstorm Force", raw: "Brainstorm Force" },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };

    pluginTools = new PluginTools();
  });

  // ── getTools ────────────────────────────────────────────────────────────

  describe("getTools", () => {
    it("should return 7 tools", () => {
      const tools = pluginTools.getTools();
      expect(tools).toHaveLength(7);
    });

    it("should include all expected tool names", () => {
      const names = pluginTools.getTools().map((t) => t.name);
      expect(names).toContain("wp_list_plugins");
      expect(names).toContain("wp_get_plugin");
      expect(names).toContain("wp_activate_plugin");
      expect(names).toContain("wp_deactivate_plugin");
      expect(names).toContain("wp_install_plugin");
      expect(names).toContain("wp_list_themes");
      expect(names).toContain("wp_get_theme");
    });

    it("each tool should have name, description, inputSchema, and handler", () => {
      pluginTools.getTools().forEach((tool) => {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("inputSchema");
        expect(tool).toHaveProperty("handler");
        expect(typeof tool.handler).toBe("function");
      });
    });

    it("write tools should declare required params", () => {
      const tools = pluginTools.getTools();
      const activate = tools.find((t) => t.name === "wp_activate_plugin");
      expect(activate.inputSchema.required).toContain("plugin");

      const install = tools.find((t) => t.name === "wp_install_plugin");
      expect(install.inputSchema.required).toContain("slug");

      const getTheme = tools.find((t) => t.name === "wp_get_theme");
      expect(getTheme.inputSchema.required).toContain("stylesheet");
    });
  });

  // ── wp_list_plugins ─────────────────────────────────────────────────────

  describe("wp_list_plugins", () => {
    it("should list plugins and return count + summary", async () => {
      mockClient.get.mockResolvedValue(MOCK_PLUGINS);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_list_plugins");
      const result = await tool.handler(mockClient, {});

      expect(mockClient.get).toHaveBeenCalledWith("plugins");
      expect(result.count).toBe(2);
      expect(result.plugins).toHaveLength(2);
      expect(result.plugins[0].plugin).toBe("akismet/akismet");
      expect(result.plugins[0].status).toBe("active");
    });

    it("should return count 0 and empty array when no plugins installed", async () => {
      mockClient.get.mockResolvedValue([]);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_list_plugins");
      const result = await tool.handler(mockClient, {});

      expect(result.count).toBe(0);
      expect(result.plugins).toEqual([]);
    });

    it("should propagate errors from the client", async () => {
      mockClient.get.mockRejectedValue(new Error("403 Forbidden"));

      const tool = pluginTools.getTools().find((t) => t.name === "wp_list_plugins");
      await expect(tool.handler(mockClient, {})).rejects.toThrow("403 Forbidden");
    });
  });

  // ── wp_get_plugin ───────────────────────────────────────────────────────

  describe("wp_get_plugin", () => {
    it("should get a plugin by path and return full details", async () => {
      mockClient.get.mockResolvedValue(MOCK_PLUGINS[0]);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_get_plugin");
      const result = await tool.handler(mockClient, { plugin: "akismet/akismet" });

      expect(mockClient.get).toHaveBeenCalledWith("plugins/akismet%2Fakismet");
      expect(result.plugin).toBe("akismet/akismet");
    });

    it("should throw if 'plugin' param is missing", async () => {
      const tool = pluginTools.getTools().find((t) => t.name === "wp_get_plugin");
      await expect(tool.handler(mockClient, {})).rejects.toThrow("'plugin' parameter is required");
    });
  });

  // ── wp_activate_plugin ──────────────────────────────────────────────────

  describe("wp_activate_plugin", () => {
    it("should activate a plugin and return success + plugin data", async () => {
      const activated = { ...MOCK_PLUGINS[1], status: "active" };
      mockClient.put.mockResolvedValue(activated);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_activate_plugin");
      const result = await tool.handler(mockClient, { plugin: "hello-dolly/hello" });

      expect(mockClient.put).toHaveBeenCalledWith("plugins/hello-dolly%2Fhello", { status: "active" });
      expect(result.success).toBe(true);
      expect(result.plugin.status).toBe("active");
    });

    it("should return a non-fatal blocked object on 403 from managed host", async () => {
      const err = new Error("Forbidden");
      err.status = 403;
      mockClient.put.mockRejectedValue(err);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_activate_plugin");
      const result = await tool.handler(mockClient, { plugin: "akismet/akismet" });

      expect(result.blocked).toBe(true);
      expect(result.message).toMatch(/host has disabled/i);
      expect(result.http_status).toBe(403);
    });

    it("should return a non-fatal blocked object on 500 from managed host", async () => {
      const err = new Error("Internal Server Error");
      err.status = 500;
      mockClient.put.mockRejectedValue(err);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_activate_plugin");
      const result = await tool.handler(mockClient, { plugin: "akismet/akismet" });

      expect(result.blocked).toBe(true);
      expect(result.http_status).toBe(500);
    });

    it("should re-throw unexpected errors (not 403/500)", async () => {
      mockClient.put.mockRejectedValue(new Error("Network timeout"));

      const tool = pluginTools.getTools().find((t) => t.name === "wp_activate_plugin");
      await expect(tool.handler(mockClient, { plugin: "akismet/akismet" })).rejects.toThrow("Network timeout");
    });

    it("should throw if 'plugin' param is missing", async () => {
      const tool = pluginTools.getTools().find((t) => t.name === "wp_activate_plugin");
      await expect(tool.handler(mockClient, {})).rejects.toThrow("'plugin' parameter is required");
    });
  });

  // ── wp_deactivate_plugin ────────────────────────────────────────────────

  describe("wp_deactivate_plugin", () => {
    it("should deactivate a plugin and return success + plugin data", async () => {
      const deactivated = { ...MOCK_PLUGINS[0], status: "inactive" };
      mockClient.put.mockResolvedValue(deactivated);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_deactivate_plugin");
      const result = await tool.handler(mockClient, { plugin: "akismet/akismet" });

      expect(mockClient.put).toHaveBeenCalledWith("plugins/akismet%2Fakismet", { status: "inactive" });
      expect(result.success).toBe(true);
      expect(result.plugin.status).toBe("inactive");
    });

    it("should return a non-fatal blocked object on managed host 403", async () => {
      const err = new Error("Forbidden");
      err.status = 403;
      mockClient.put.mockRejectedValue(err);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_deactivate_plugin");
      const result = await tool.handler(mockClient, { plugin: "akismet/akismet" });

      expect(result.blocked).toBe(true);
    });
  });

  // ── wp_install_plugin ───────────────────────────────────────────────────

  describe("wp_install_plugin", () => {
    it("should install a plugin from WP.org and return success", async () => {
      const installed = { plugin: "contact-form-7/wp-contact-form-7", name: "Contact Form 7", status: "inactive" };
      mockClient.post.mockResolvedValue(installed);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_install_plugin");
      const result = await tool.handler(mockClient, { slug: "contact-form-7" });

      expect(mockClient.post).toHaveBeenCalledWith("plugins", { slug: "contact-form-7" });
      expect(result.success).toBe(true);
      expect(result.plugin.name).toBe("Contact Form 7");
    });

    it("should return a non-fatal blocked object on managed host 403", async () => {
      const err = new Error("Forbidden");
      err.status = 403;
      mockClient.post.mockRejectedValue(err);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_install_plugin");
      const result = await tool.handler(mockClient, { slug: "woocommerce" });

      expect(result.blocked).toBe(true);
      expect(result.message).toMatch(/hosting control panel/i);
    });

    it("should throw if 'slug' param is missing", async () => {
      const tool = pluginTools.getTools().find((t) => t.name === "wp_install_plugin");
      await expect(tool.handler(mockClient, {})).rejects.toThrow("'slug' parameter is required");
    });
  });

  // ── wp_list_themes ──────────────────────────────────────────────────────

  describe("wp_list_themes", () => {
    it("should list themes and return count + summary", async () => {
      mockClient.get.mockResolvedValue(MOCK_THEMES);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_list_themes");
      const result = await tool.handler(mockClient, {});

      expect(mockClient.get).toHaveBeenCalledWith("themes");
      expect(result.count).toBe(2);
      expect(result.themes[0].stylesheet).toBe("twentytwentythree");
      expect(result.themes[0].status).toBe("active");
      expect(result.themes[0].name).toBe("Twenty Twenty-Three");
    });

    it("should propagate errors from the client", async () => {
      mockClient.get.mockRejectedValue(new Error("401 Unauthorized"));
      const tool = pluginTools.getTools().find((t) => t.name === "wp_list_themes");
      await expect(tool.handler(mockClient, {})).rejects.toThrow("401 Unauthorized");
    });
  });

  // ── wp_get_theme ────────────────────────────────────────────────────────

  describe("wp_get_theme", () => {
    it("should get a theme by stylesheet slug", async () => {
      mockClient.get.mockResolvedValue(MOCK_THEMES[0]);

      const tool = pluginTools.getTools().find((t) => t.name === "wp_get_theme");
      const result = await tool.handler(mockClient, { stylesheet: "twentytwentythree" });

      expect(mockClient.get).toHaveBeenCalledWith("themes/twentytwentythree");
      expect(result.stylesheet).toBe("twentytwentythree");
    });

    it("should throw if 'stylesheet' param is missing", async () => {
      const tool = pluginTools.getTools().find((t) => t.name === "wp_get_theme");
      await expect(tool.handler(mockClient, {})).rejects.toThrow("'stylesheet' parameter is required");
    });
  });
});
