/**
 * Plugin and Theme Management Tools for WordPress MCP Server
 *
 * Exposes 7 tools:
 *   wp_list_plugins, wp_get_plugin,
 *   wp_activate_plugin, wp_deactivate_plugin, wp_install_plugin,
 *   wp_list_themes, wp_get_theme
 *
 * All plugin write operations (activate/deactivate/install) degrade gracefully on
 * managed/hardened hosts that block filesystem-level changes (403/500 → non-fatal
 * message). Mirrors the LiteSpeed graceful-degradation pattern from cache.ts.
 */

import type { WordPressClient } from "@/client/api.js";
import { PluginOperations } from "@/client/operations/plugins.js";
import type { MCPToolSchema } from "@/types/mcp.js";

type PluginToolHandler = (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;

interface PluginToolDef {
  name: string;
  description: string;
  inputSchema: MCPToolSchema;
  handler: PluginToolHandler;
}

/**
 * Plugin and theme management tools class
 */
export class PluginTools {
  getTools(): PluginToolDef[] {
    return [
      // ── Plugin tools ─────────────────────────────────────────────────────
      {
        name: "wp_list_plugins",
        description:
          "List all plugins installed on a WordPress site with their status (active/inactive) and metadata. " +
          "Requires administrator credentials (activate_plugins capability).",
        inputSchema: {
          type: "object",
          properties: {},
        },
        handler: this.handleListPlugins.bind(this),
      },
      {
        name: "wp_get_plugin",
        description:
          "Get details for a single installed plugin by its WP-relative path (e.g. 'akismet/akismet'). " +
          "Requires administrator credentials (activate_plugins capability).",
        inputSchema: {
          type: "object",
          properties: {
            plugin: {
              type: "string",
              description: "Plugin WP-relative path, e.g. 'akismet/akismet' or 'woocommerce/woocommerce'.",
            },
          },
          required: ["plugin"],
        },
        handler: this.handleGetPlugin.bind(this),
      },
      {
        name: "wp_activate_plugin",
        description:
          "Activate an installed plugin by its WP-relative path. " +
          "Requires administrator credentials. " +
          "Returns a non-fatal message if the host blocks filesystem-level activation (managed hosting).",
        inputSchema: {
          type: "object",
          properties: {
            plugin: {
              type: "string",
              description: "Plugin WP-relative path, e.g. 'akismet/akismet'.",
            },
          },
          required: ["plugin"],
        },
        handler: this.handleActivatePlugin.bind(this),
      },
      {
        name: "wp_deactivate_plugin",
        description:
          "Deactivate an active plugin by its WP-relative path. " +
          "Requires administrator credentials. " +
          "Returns a non-fatal message if the host blocks filesystem-level deactivation (managed hosting).",
        inputSchema: {
          type: "object",
          properties: {
            plugin: {
              type: "string",
              description: "Plugin WP-relative path, e.g. 'akismet/akismet'.",
            },
          },
          required: ["plugin"],
        },
        handler: this.handleDeactivatePlugin.bind(this),
      },
      {
        name: "wp_install_plugin",
        description:
          "Install a plugin from the WordPress.org plugin directory by slug. " +
          "Requires administrator credentials with filesystem write access. " +
          "Returns a non-fatal message if the host disables remote plugin installs (managed hosting).",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "WordPress.org plugin slug, e.g. 'akismet' or 'woocommerce'.",
            },
          },
          required: ["slug"],
        },
        handler: this.handleInstallPlugin.bind(this),
      },

      // ── Theme tools ──────────────────────────────────────────────────────
      {
        name: "wp_list_themes",
        description:
          "List all themes installed on a WordPress site with their activation status and metadata. " +
          "Requires administrator credentials (switch_themes capability).",
        inputSchema: {
          type: "object",
          properties: {},
        },
        handler: this.handleListThemes.bind(this),
      },
      {
        name: "wp_get_theme",
        description:
          "Get details for a single installed theme by its stylesheet slug (e.g. 'twentytwentythree'). " +
          "Requires administrator credentials (switch_themes capability).",
        inputSchema: {
          type: "object",
          properties: {
            stylesheet: {
              type: "string",
              description: "Theme stylesheet slug, e.g. 'twentytwentythree' or 'astra'.",
            },
          },
          required: ["stylesheet"],
        },
        handler: this.handleGetTheme.bind(this),
      },
    ];
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  async handleListPlugins(client: WordPressClient, _params: Record<string, unknown>): Promise<unknown> {
    const ops = new PluginOperations(client);
    const plugins = await ops.listPlugins();
    return {
      count: plugins.length,
      plugins: plugins.map((p) => ({
        plugin: p.plugin,
        name: p.name,
        status: p.status,
        version: p.version,
        author: p.author,
        requires_wp: p.requires_wp,
        requires_php: p.requires_php,
        network_only: p.network_only,
      })),
    };
  }

  async handleGetPlugin(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const plugin = params.plugin as string;
    if (!plugin) throw new Error("'plugin' parameter is required");
    const ops = new PluginOperations(client);
    return ops.getPlugin(plugin);
  }

  async handleActivatePlugin(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const plugin = params.plugin as string;
    if (!plugin) throw new Error("'plugin' parameter is required");
    const ops = new PluginOperations(client);
    const result = await ops.activatePlugin(plugin);
    if ("blocked" in result) {
      return result;
    }
    return {
      success: true,
      message: `Plugin '${plugin}' activated successfully.`,
      plugin: result,
    };
  }

  async handleDeactivatePlugin(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const plugin = params.plugin as string;
    if (!plugin) throw new Error("'plugin' parameter is required");
    const ops = new PluginOperations(client);
    const result = await ops.deactivatePlugin(plugin);
    if ("blocked" in result) {
      return result;
    }
    return {
      success: true,
      message: `Plugin '${plugin}' deactivated successfully.`,
      plugin: result,
    };
  }

  async handleInstallPlugin(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const slug = params.slug as string;
    if (!slug) throw new Error("'slug' parameter is required");
    const ops = new PluginOperations(client);
    const result = await ops.installPlugin(slug);
    if ("blocked" in result) {
      return result;
    }
    return {
      success: true,
      message: `Plugin '${slug}' installed successfully.`,
      plugin: result,
    };
  }

  async handleListThemes(client: WordPressClient, _params: Record<string, unknown>): Promise<unknown> {
    const ops = new PluginOperations(client);
    const themes = await ops.listThemes();
    return {
      count: themes.length,
      themes: themes.map((t) => ({
        stylesheet: t.stylesheet,
        template: t.template,
        status: t.status,
        name: t.name?.rendered ?? t.name?.raw,
        version: t.version,
        author: t.author?.rendered ?? t.author?.raw,
        requires_wp: t.requires_wp,
        requires_php: t.requires_php,
      })),
    };
  }

  async handleGetTheme(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const stylesheet = params.stylesheet as string;
    if (!stylesheet) throw new Error("'stylesheet' parameter is required");
    const ops = new PluginOperations(client);
    return ops.getTheme(stylesheet);
  }
}

export default PluginTools;
