import { WordPressClient } from "@/client/api.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { AuthMethod } from "@/types/client.js";
import { getErrorMessage } from "@/utils/error.js";

/**
 * Provides authentication-related tools for WordPress sites.
 * This class encapsulates tool definitions and their corresponding handlers.
 */
export class AuthTools {
  /**
   * Retrieves the list of authentication tools.
   * @returns An array of MCPTool definitions.
   */
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema?: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_test_auth",
        description:
          "Tests the authentication and connectivity for a configured WordPress site with detailed connection diagnostics.\n\n" +
          "**Usage Examples:**\n" +
          "• Test connection: `wp_test_auth`\n" +
          '• Multi-site test: `wp_test_auth --site="my-site"`\n' +
          "• Verify setup: Use this after configuring new credentials\n" +
          "• Troubleshoot: Run when experiencing connection issues\n" +
          "• Health check: Regular verification of WordPress connectivity",
        // The 'site' parameter is added dynamically by the server
        inputSchema: {
          type: "object",
          properties: {},
        },
        handler: this.handleTestAuth.bind(this),
      },
      {
        name: "wp_get_auth_status",
        description: "Gets the current authentication status for a configured WordPress site.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        handler: this.handleGetAuthStatus.bind(this),
      },
      {
        name: "wp_switch_auth_method",
        description: "Switches the authentication method for a site for the current session.",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              description: "The new authentication method to use.",
              enum: ["app-password", "jwt", "basic", "api-key", "cookie"],
            },
            username: {
              type: "string",
              description: "The username for 'app-password' or 'basic' authentication.",
            },
            password: {
              type: "string",
              description: "The Application Password for 'app-password' or password for 'basic' auth.",
            },
            jwt_token: {
              type: "string",
              description: "The token for 'jwt' authentication.",
            },
          },
          required: ["method"],
        },
        handler: this.handleSwitchAuthMethod.bind(this),
      },
    ];
  }

  /**
   * Handles the 'wp_test_auth' tool request.
   *
   * Primary probe: GET /settings — returns 200 for admins/editors and works on
   * LiteSpeed/Wordfence sites that 403 /users/me. Secondary probe (best-effort):
   * GET /users/me — only used to enrich the response with the user name/roles;
   * a 403 there is tolerated so the tool reports success on restricted hosts.
   *
   * @param client - The WordPressClient instance for the target site.
   * @param params - The parameters for the tool request.
   * @returns A promise that resolves to an MCPToolResponse.
   */
  public async handleTestAuth(
    client: WordPressClient,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const siteConfig = client.config;
    try {
      // Primary auth check: GET /settings (authenticated, non-/users endpoint).
      // LiteSpeed and Wordfence sites block /users/me but allow /settings for admins.
      await client.getSiteSettings();

      // Secondary: try to get user details for the response — tolerate 403 from
      // hosts that block /users/me (GXR, Bud, PDL with LiteSpeed rules).
      let userLine = "N/A";
      let rolesLine = "N/A";
      try {
        const user = await client.getCurrentUser();
        userLine = `${user.name} (@${user.slug})`;
        rolesLine = user.roles?.join(", ") || "N/A";
      } catch {
        // /users/me blocked — auth still confirmed via /settings above
        userLine = "(details blocked by host — auth confirmed via /settings)";
      }

      const content =
        "✅ **Authentication successful!**\n\n" +
        `**Site:** ${siteConfig.baseUrl}\n` +
        `**Method:** ${siteConfig.auth.method}\n` +
        `**User:** ${userLine}\n` +
        `**Roles:** ${rolesLine}\n\n` +
        "Your WordPress connection is working properly.";

      return { content };
    } catch (_error) {
      throw new Error(`Authentication test failed: ${getErrorMessage(_error)}`);
    }
  }

  /**
   * Handles the 'wp_get_auth_status' tool request.
   * Reports whether the client is currently authenticated.
   * @param client - The WordPressClient instance for the target site.
   * @param params - The parameters for the tool request.
   * @returns A promise that resolves to an MCPToolResponse.
   */
  public async handleGetAuthStatus(
    client: WordPressClient,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const config = client.config;
      let content = `**Authentication Status for ${config.baseUrl}**\n\n` + `**Method:** ${config.auth.method}\n`;

      // Always do a live probe so the status reflects current reality,
      // not a stale in-memory flag that may not have been set yet.
      try {
        const user = await client.getCurrentUser();
        content =
          `**Authentication Status for ${config.baseUrl}**\n\n` +
          `**Authenticated:** ✅ Yes\n` +
          `**Method:** ${config.auth.method}\n` +
          `**User:** ${user.name} (@${user.slug})\n`;
      } catch {
        content +=
          `**Authenticated:** ❌ No\n` + "**Status:** Not connected. Use 'wp_test_auth' to verify credentials.";
      }

      return { content };
    } catch (_error) {
      throw new Error(`Failed to get auth status: ${getErrorMessage(_error)}`);
    }
  }

  /**
   * Handles the 'wp_switch_auth_method' tool request.
   * Updates the client's authentication configuration in memory for the session.
   * @param client - The WordPressClient instance for the target site.
   * @param params - The parameters for the tool request, including the new auth details.
   * @returns A promise that resolves to an MCPToolResponse.
   */
  public async handleSwitchAuthMethod(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const {
      method: _method,
      username: _username,
      password: _password,
      jwt_token: _jwt_token,
    } = params as {
      method: AuthMethod;
      username?: string;
      password?: string;
      jwt_token?: string;
    };
    try {
      // This functionality is not currently supported as the client
      // doesn't have an updateAuthConfig method
      throw new Error(
        "Dynamic authentication method switching is not currently supported. Please update your configuration file and restart the server.",
      );
    } catch (_error) {
      throw new Error(`Failed to switch auth method: ${getErrorMessage(_error)}`);
    }
  }
}

export default AuthTools;
