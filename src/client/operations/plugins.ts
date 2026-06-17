/**
 * Plugin and Theme Operations Module
 * Handles plugin and theme management via the WordPress REST API v2.
 *
 * NOTE: Many managed/hardened hosts disable plugin install and activation at the
 * filesystem level and will return 403 or 500. All write operations (activate,
 * deactivate, install) catch these gracefully and return a non-fatal blocked object
 * rather than throwing, mirroring the LiteSpeed graceful-degradation pattern.
 *
 * Capabilities required:
 *   - list/get plugins: activate_plugins
 *   - activate/deactivate/install: activate_plugins + manage_options (usually admin)
 *   - list/get themes: switch_themes
 */

/**
 * Interface for the base client methods needed by plugin/theme operations
 */
export interface PluginClientBase {
  get<T>(endpoint: string): Promise<T>;
  post<T>(endpoint: string, data?: unknown): Promise<T>;
  put<T>(endpoint: string, data?: unknown): Promise<T>;
}

/** WP REST API shape for a plugin (wp/v2/plugins) */
export interface WordPressPlugin {
  plugin: string; // e.g. "akismet/akismet"
  status: "active" | "inactive" | "network-active";
  name: string;
  plugin_uri?: string;
  author?: string;
  author_uri?: string;
  description?: { rendered?: string; raw?: string };
  version?: string;
  network_only?: boolean;
  requires_wp?: string;
  requires_php?: string;
  textdomain?: string;
  _links?: Record<string, unknown>;
}

/** WP REST API shape for a theme (wp/v2/themes) */
export interface WordPressTheme {
  stylesheet: string; // theme slug / filesystem name
  template: string;
  status: "active" | "inactive";
  name?: { rendered?: string; raw?: string };
  description?: { rendered?: string; raw?: string };
  author?: { rendered?: string; raw?: string };
  author_uri?: { rendered?: string; raw?: string };
  version?: string;
  requires_php?: string;
  requires_wp?: string;
  theme_uri?: { rendered?: string; raw?: string };
  textdomain?: string;
  tags?: { rendered?: string; raw?: string };
  _links?: Record<string, unknown>;
}

/** Returned when a host blocks filesystem-level plugin operations */
export interface HostBlockedResult {
  blocked: true;
  message: string;
  http_status?: number;
}

/**
 * Plugin and theme operations class
 * Provides operations for WordPress plugin and theme management
 */
export class PluginOperations {
  constructor(private client: PluginClientBase) {}

  /**
   * List all plugins installed on the site.
   * Requires activate_plugins capability (administrator).
   */
  async listPlugins(): Promise<WordPressPlugin[]> {
    return this.client.get<WordPressPlugin[]>("plugins");
  }

  /**
   * Get a single plugin by its WP-relative path (e.g. "akismet/akismet").
   * Requires activate_plugins capability (administrator).
   */
  async getPlugin(plugin: string): Promise<WordPressPlugin> {
    return this.client.get<WordPressPlugin>(`plugins/${encodeURIComponent(plugin)}`);
  }

  /**
   * Activate a plugin by its WP-relative path.
   * Requires activate_plugins + manage_options (administrator).
   * Returns HostBlockedResult on 403/500 from managed hosts.
   */
  async activatePlugin(plugin: string): Promise<WordPressPlugin | HostBlockedResult> {
    try {
      return await this.client.put<WordPressPlugin>(`plugins/${encodeURIComponent(plugin)}`, {
        status: "active",
      });
    } catch (err) {
      return this._handleHostBlocked("activate plugin", err);
    }
  }

  /**
   * Deactivate a plugin by its WP-relative path.
   * Requires activate_plugins + manage_options (administrator).
   * Returns HostBlockedResult on 403/500 from managed hosts.
   */
  async deactivatePlugin(plugin: string): Promise<WordPressPlugin | HostBlockedResult> {
    try {
      return await this.client.put<WordPressPlugin>(`plugins/${encodeURIComponent(plugin)}`, {
        status: "inactive",
      });
    } catch (err) {
      return this._handleHostBlocked("deactivate plugin", err);
    }
  }

  /**
   * Install a plugin from WordPress.org by slug.
   * Many managed hosts disable direct plugin installs — non-fatal on 403/500.
   * Requires manage_options (administrator) + filesystem write access.
   */
  async installPlugin(slug: string): Promise<WordPressPlugin | HostBlockedResult> {
    try {
      return await this.client.post<WordPressPlugin>("plugins", { slug });
    } catch (err) {
      return this._handleHostBlocked("install plugin", err);
    }
  }

  /**
   * List all themes installed on the site.
   * Requires switch_themes capability (administrator).
   */
  async listThemes(): Promise<WordPressTheme[]> {
    return this.client.get<WordPressTheme[]>("themes");
  }

  /**
   * Get a single theme by its stylesheet slug (e.g. "twentytwentythree").
   * Requires switch_themes capability (administrator).
   */
  async getTheme(stylesheet: string): Promise<WordPressTheme> {
    return this.client.get<WordPressTheme>(`themes/${encodeURIComponent(stylesheet)}`);
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private _handleHostBlocked(action: string, err: unknown): HostBlockedResult {
    const status =
      (err as { status?: number })?.status ?? (err as { response?: { status?: number } })?.response?.status;

    // Only absorb errors that indicate a host-level block
    if (status === 403 || status === 500) {
      return {
        blocked: true,
        http_status: status,
        message:
          `Unable to ${action}: the host has disabled filesystem-level plugin management ` +
          `(HTTP ${status}). Use your hosting control panel or WP-CLI instead.`,
      };
    }

    // Re-throw unexpected errors so callers see them
    throw err;
  }
}
