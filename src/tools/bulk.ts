/**
 * Bulk / Multi-Site Tools for WordPress MCP Server
 *
 * Exposes one tool:
 *   wp_bulk — fan a single operation across N sites and return per-site results.
 *
 * Design notes:
 *   - Receives the wordpressClients Map in its constructor (same pattern as
 *     CacheTools / PerformanceTools — special-cased in ToolRegistry.registerAllTools).
 *   - Builds a handler registry at construction time by instantiating all stateless
 *     tool classes and collecting their handlers. No REST calls are reimplemented here.
 *   - Read-only detection: any tool whose name starts with "wp_list_", "wp_get_",
 *     or "wp_search_" is considered read-only. Everything else requires confirm:true.
 *   - Returns Array<{ site, ok: true, result } | { site, ok: false, error }> so
 *     callers always get a full per-site picture.
 */

import type { WordPressClient } from "@/client/api.js";
import { LoggerFactory } from "@/utils/logger.js";
import type { MCPToolSchema } from "@/types/mcp.js";

// ── Import stateless tool classes directly (not via barrel, avoids potential
//    circular dependency once BulkTools is added to the barrel). ──────────────
import { PostTools } from "./posts/index.js";
import { PageTools } from "./pages.js";
import { MediaTools } from "./media.js";
import { UserTools } from "./users.js";
import { CommentTools } from "./comments.js";
import { TaxonomyTools } from "./taxonomies.js";
import { SiteTools } from "./site.js";
import { PluginTools } from "./plugins.js";
import SystemTools from "./system.js";
import { AuthTools } from "./auth.js";

// ── Types ───────────────────────────────────────────────────────────────────

type ToolHandler = (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;

export interface BulkSiteResult {
  site: string;
  ok: true;
  result: unknown;
}

export interface BulkSiteError {
  site: string;
  ok: false;
  error: string;
}

export type BulkResult = BulkSiteResult | BulkSiteError;

/** Prefixes that unambiguously identify a read-only (idempotent GET) operation */
const READ_ONLY_PREFIXES = ["wp_list_", "wp_get_", "wp_search_", "wp_check_", "wp_cache_stats", "wp_cache_info"];

function isReadOnly(toolName: string): boolean {
  return READ_ONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

/**
 * Bulk / multi-site tools class
 */
export class BulkTools {
  private readonly logger = LoggerFactory.tool("bulk");
  private readonly handlerRegistry: Map<string, ToolHandler>;

  /**
   * @param clients The full wordpressClients map (all configured sites)
   */
  constructor(private clients: Map<string, WordPressClient>) {
    this.handlerRegistry = this.buildHandlerRegistry();
  }

  /**
   * Build the handler registry by instantiating every stateless tool class
   * and collecting their { name → handler } pairs.
   * Uses `unknown[]` casts because tool classes have varying return-type annotations.
   */
  private buildHandlerRegistry(): Map<string, ToolHandler> {
    const registry = new Map<string, ToolHandler>();

    // Stateless tool instances (no clients-map dependency)
    const toolInstances: Array<{ getTools(): unknown[] }> = [
      new PostTools(),
      new PageTools(),
      new MediaTools(),
      new UserTools(),
      new CommentTools(),
      new TaxonomyTools(),
      new SiteTools(),
      new PluginTools(),
      new SystemTools(),
      new AuthTools(),
    ];

    for (const instance of toolInstances) {
      for (const rawTool of instance.getTools()) {
        const tool = rawTool as { name: string; handler: ToolHandler };
        if (tool.name && typeof tool.handler === "function") {
          registry.set(tool.name, tool.handler);
        }
      }
    }

    this.logger.debug(`BulkTools: registered ${registry.size} dispatchable tool handlers`);
    return registry;
  }

  getTools(): Array<{
    name: string;
    description: string;
    inputSchema: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_bulk",
        description:
          "Fan a single WordPress operation across multiple sites and return per-site results. " +
          "Specify 'sites' as an array of site IDs or the string 'all' to target every configured site. " +
          "Read-only tools (wp_list_*, wp_get_*, wp_search_*) run without confirmation. " +
          "Write/mutating tools REQUIRE confirm:true or the call is rejected. " +
          "Returns an array of { site, ok, result | error } objects — one per targeted site.",
        inputSchema: {
          type: "object",
          properties: {
            sites: {
              type: "string",
              description:
                "Sites to target. Use 'all' to run against every configured site, " +
                "or a comma-separated list of site IDs from mcp-wordpress.config.json " +
                "(e.g. 'apwa,iseal,pdl').",
            },
            operation: {
              type: "string",
              description: "The wp_* tool name to execute on each site, e.g. 'wp_list_plugins'.",
            },
            params: {
              type: "object",
              description:
                "Parameters to pass to the operation. The 'site' key is automatically overridden " +
                "per-site — do not include it here.",
            },
            confirm: {
              type: "boolean",
              description:
                "Set to true to authorise write/mutating operations across the chosen sites. " +
                "Required for any tool that is not a read-only wp_list_*, wp_get_*, or wp_search_* call. " +
                "Ignored for read-only operations.",
            },
          },
          required: ["sites", "operation"],
        },
        // The handler signature receives a per-call client (from ToolRegistry) but wp_bulk
        // ignores it — it uses this.clients directly to fan across all targeted sites.
        handler: this.handleBulk.bind(this),
      },
    ];
  }

  /**
   * Fan `operation` across the chosen sites and return per-site results.
   * `sites` is either the string "all" or a comma-separated list of site IDs.
   */
  async handleBulk(_client: WordPressClient, params: Record<string, unknown>): Promise<BulkResult[]> {
    const {
      sites,
      operation,
      params: opParams = {},
      confirm = false,
    } = params as {
      sites: string;
      operation: string;
      params?: Record<string, unknown>;
      confirm?: boolean;
    };

    // ── Validate operation ────────────────────────────────────────────────
    if (!operation || typeof operation !== "string") {
      throw new Error("'operation' must be a non-empty tool name string (e.g. 'wp_list_plugins').");
    }

    const handler = this.handlerRegistry.get(operation);
    if (!handler) {
      const known = Array.from(this.handlerRegistry.keys()).sort().join(", ");
      throw new Error(`Unknown operation '${operation}'. Known dispatchable tools: ${known}`);
    }

    // ── Write-safety gate ─────────────────────────────────────────────────
    const targetDescription = sites === "all" ? "all sites" : `site(s): ${sites}`;
    if (!isReadOnly(operation) && !confirm) {
      throw new Error(
        `'${operation}' is a write/mutating operation. ` +
          `Pass confirm:true to authorise running it across ${targetDescription}.`,
      );
    }

    // ── Resolve target sites ──────────────────────────────────────────────
    let targetSiteIds: string[];
    if (!sites || typeof sites !== "string") {
      throw new Error("'sites' must be the string 'all' or a comma-separated list of site IDs.");
    }

    if (sites.trim() === "all") {
      targetSiteIds = Array.from(this.clients.keys());
    } else {
      const requested = sites
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (requested.length === 0) {
        throw new Error("'sites' must be the string 'all' or a comma-separated list of site IDs.");
      }
      // Validate that each requested site exists
      const unknownSites = requested.filter((id) => !this.clients.has(id));
      if (unknownSites.length > 0) {
        throw new Error(
          `Unknown site ID(s): ${unknownSites.join(", ")}. ` +
            `Configured sites: ${Array.from(this.clients.keys()).join(", ")}`,
        );
      }
      targetSiteIds = requested;
    }

    if (targetSiteIds.length === 0) {
      throw new Error("No sites configured — cannot run wp_bulk.");
    }

    this.logger.info(`wp_bulk: running '${operation}' across [${targetSiteIds.join(", ")}]`);

    // ── Fan out in parallel ───────────────────────────────────────────────
    const results: BulkResult[] = await Promise.all(
      targetSiteIds.map(async (siteId): Promise<BulkResult> => {
        const siteClient = this.clients.get(siteId);
        if (!siteClient) {
          return { site: siteId, ok: false, error: `Site '${siteId}' not found in clients map.` };
        }

        try {
          // Strip any caller-supplied 'site' key — each iteration uses its own client
          const { site: _ignored, ...cleanParams } = opParams as Record<string, unknown>;
          const result = await handler(siteClient, cleanParams);
          return { site: siteId, ok: true, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`wp_bulk: site '${siteId}' error: ${message}`);
          return { site: siteId, ok: false, error: message };
        }
      }),
    );

    return results;
  }
}

export default BulkTools;
