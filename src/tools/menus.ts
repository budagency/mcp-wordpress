/**
 * WordPress Nav Menus, Menu Items, Widgets & Sidebars Tools
 *
 * Covers the WP REST API v2 endpoints added in WP 5.9:
 *   GET/POST/PUT/DELETE  /wp/v2/menus[/<id>]
 *   GET/POST/PUT/DELETE  /wp/v2/menu-items[/<id>]
 *   GET/PUT              /wp/v2/widgets[/<id>]
 *   GET                  /wp/v2/sidebars[/<id>]
 *
 * All endpoints require the `edit_theme_options` capability (admin).
 * A 403 or 404 response (LiteSpeed, Wordfence, WP < 5.9, or capability
 * mismatch) is reported as a clear user-facing error rather than throwing
 * an opaque stack trace.
 *
 * Registration: add to src/tools/index.ts:
 *   export { default as MenuTools } from "./menus.js";
 */

import { WordPressClient } from "@/client/api.js";
import type {
  CreateMenuRequest,
  UpdateMenuRequest,
  CreateMenuItemRequest,
  UpdateMenuItemRequest,
} from "@/client/operations/menus.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { getErrorMessage } from "@/utils/error.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip properties whose value is `undefined` so callers don't accidentally
 * pass `{ prop: undefined }` to operations that use exactOptionalPropertyTypes.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Detect endpoint-absent / permission errors and emit a helpful message. */
function isCapabilityOrVersionError(error: unknown): boolean {
  const msg = getErrorMessage(error).toLowerCase();
  return (
    msg.includes("403") ||
    msg.includes("404") ||
    msg.includes("forbidden") ||
    msg.includes("not found") ||
    msg.includes("rest_no_route") ||
    msg.includes("rest_forbidden")
  );
}

function handleMenuError(verb: string, endpoint: string, error: unknown): never {
  const msg = getErrorMessage(error);
  if (isCapabilityOrVersionError(error)) {
    throw new Error(
      `${verb} failed (${msg}).\n` +
        `This endpoint (${endpoint}) requires WordPress 5.9+ and edit_theme_options capability (admin). ` +
        "LiteSpeed / Wordfence sites may block it if the user lacks the required role.",
    );
  }
  throw new Error(`${verb} failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// MenuTools class
// ---------------------------------------------------------------------------

export class MenuTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      // ── Menus ────────────────────────────────────────────────────────────

      {
        name: "wp_list_menus",
        description:
          "Lists all registered nav menus on the WordPress site (WP 5.9+). " +
          "Returns menu IDs, names, slugs, assigned locations, and whether items are auto-added.\n\n" +
          "Requires: WordPress 5.9+, admin (edit_theme_options).",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: this.handleListMenus.bind(this),
      },
      {
        name: "wp_get_menu",
        description: "Retrieves a single nav menu by its ID including its assigned locations.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The menu ID." },
          },
          required: ["id"],
        },
        handler: this.handleGetMenu.bind(this),
      },
      {
        name: "wp_create_menu",
        description:
          "Creates a new nav menu. After creation, add items with wp_create_menu_item and assign " +
          "a theme location via `locations`.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Display name for the menu." },
            slug: { type: "string", description: "Unique slug. Auto-generated from name if omitted." },
            description: { type: "string", description: "Optional description." },
            auto_add: {
              type: "boolean",
              description: "Automatically add top-level pages to this menu. Default: false.",
            },
            locations: {
              type: "array",
              items: { type: "string" },
              description: 'Theme location slugs to assign this menu to (e.g. ["primary"]).',
            },
          },
          required: ["name"],
        },
        handler: this.handleCreateMenu.bind(this),
      },
      {
        name: "wp_update_menu",
        description: "Updates a nav menu's name, slug, description, auto-add setting, or assigned locations.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The menu ID to update." },
            name: { type: "string", description: "New display name." },
            slug: { type: "string", description: "New slug." },
            description: { type: "string", description: "New description." },
            auto_add: { type: "boolean", description: "Whether to auto-add top-level pages." },
            locations: {
              type: "array",
              items: { type: "string" },
              description: "New set of theme location slugs.",
            },
          },
          required: ["id"],
        },
        handler: this.handleUpdateMenu.bind(this),
      },
      {
        name: "wp_delete_menu",
        description: "Permanently deletes a nav menu and all its items.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The menu ID to delete." },
          },
          required: ["id"],
        },
        handler: this.handleDeleteMenu.bind(this),
      },

      // ── Menu Items ────────────────────────────────────────────────────────

      {
        name: "wp_list_menu_items",
        description:
          "Lists menu items, optionally filtered by menu ID. Returns each item's URL, label, " + "parent, and order.",
        inputSchema: {
          type: "object",
          properties: {
            menus: { type: "number", description: "Filter items belonging to this menu ID." },
            per_page: { type: "number", description: "Items per page (max 100). Default: 100." },
            page: { type: "number", description: "Page number for pagination." },
            search: { type: "string", description: "Search term to filter items." },
            parent: { type: "number", description: "Filter by parent item ID (0 for top-level)." },
          },
          required: [],
        },
        handler: this.handleListMenuItems.bind(this),
      },
      {
        name: "wp_create_menu_item",
        description: "Creates a new menu item inside a specified menu.",
        inputSchema: {
          type: "object",
          properties: {
            menus: { type: "number", description: "The menu ID this item belongs to." },
            title: { type: "string", description: "The display label for this item." },
            url: { type: "string", description: "The URL the item links to (for custom-link items)." },
            type: {
              type: "string",
              description: "Item type: 'custom', 'post_type', 'taxonomy', 'post_type_archive'. Default: custom.",
              enum: ["custom", "post_type", "taxonomy", "post_type_archive"],
            },
            object: {
              type: "string",
              description: "Object type (e.g. 'post', 'page', 'category') for post_type/taxonomy items.",
            },
            object_id: {
              type: "number",
              description: "The ID of the linked object for post_type/taxonomy items.",
            },
            parent: { type: "number", description: "Parent menu item ID (0 for top-level)." },
            menu_order: { type: "number", description: "Position among siblings (1-based)." },
            target: { type: "string", description: "Link target: '' or '_blank'.", enum: ["", "_blank"] },
            attr_title: { type: "string", description: "HTML title attribute for the link." },
            description: { type: "string", description: "Description displayed in some themes." },
            classes: { type: "array", items: { type: "string" }, description: "CSS classes to add." },
            xfn: { type: "array", items: { type: "string" }, description: "XFN relationship strings." },
            status: {
              type: "string",
              description: "Item status. Default: 'publish'.",
              enum: ["publish", "draft"],
            },
          },
          required: ["menus", "title"],
        },
        handler: this.handleCreateMenuItem.bind(this),
      },
      {
        name: "wp_update_menu_item",
        description: "Updates an existing menu item. All fields except id are optional.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The menu item ID to update." },
            menus: { type: "number", description: "Move item to a different menu." },
            title: { type: "string", description: "New display label." },
            url: { type: "string", description: "New URL." },
            type: { type: "string", enum: ["custom", "post_type", "taxonomy", "post_type_archive"] },
            object: { type: "string" },
            object_id: { type: "number" },
            parent: { type: "number", description: "New parent item ID." },
            menu_order: { type: "number", description: "New position." },
            target: { type: "string", enum: ["", "_blank"] },
            attr_title: { type: "string" },
            description: { type: "string" },
            classes: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["publish", "draft"] },
          },
          required: ["id"],
        },
        handler: this.handleUpdateMenuItem.bind(this),
      },
      {
        name: "wp_delete_menu_item",
        description: "Permanently deletes a menu item.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The menu item ID to delete." },
          },
          required: ["id"],
        },
        handler: this.handleDeleteMenuItem.bind(this),
      },

      // ── Widgets ───────────────────────────────────────────────────────────

      {
        name: "wp_list_widgets",
        description:
          "Lists all active widget instances. Optionally filter by sidebar ID. " +
          "Returns each widget's ID, type, sidebar, and rendered HTML.",
        inputSchema: {
          type: "object",
          properties: {
            sidebar: { type: "string", description: "Filter widgets belonging to this sidebar ID." },
          },
          required: [],
        },
        handler: this.handleListWidgets.bind(this),
      },
      {
        name: "wp_get_widget",
        description: "Retrieves a single widget instance by its unique ID string.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The widget's unique ID string (e.g. 'block-2')." },
          },
          required: ["id"],
        },
        handler: this.handleGetWidget.bind(this),
      },
      {
        name: "wp_update_widget",
        description:
          "Updates a widget's settings or moves it to a different sidebar. " +
          "Pass instance.raw for block widgets or sidebar to reassign.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The widget's unique ID string." },
            sidebar: { type: "string", description: "New sidebar ID to move the widget to." },
            instance: {
              type: "object",
              description: "Widget instance settings. For block widgets: { raw: { content: '...' } }.",
            },
          },
          required: ["id"],
        },
        handler: this.handleUpdateWidget.bind(this),
      },

      // ── Sidebars ──────────────────────────────────────────────────────────

      {
        name: "wp_list_sidebars",
        description:
          "Lists all registered widget areas (sidebars) on the site, including active and inactive ones. " +
          "Returns each sidebar's ID, name, description, and status.",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: this.handleListSidebars.bind(this),
      },
    ];
  }

  // ── Menu Handlers ─────────────────────────────────────────────────────────

  public async handleListMenus(client: WordPressClient, _params: Record<string, unknown>): Promise<unknown> {
    try {
      const menus = await client.listMenus();
      if (menus.length === 0) return "No nav menus found on this site.";
      return (
        `Found ${menus.length} nav menu(s):\n\n` +
        menus
          .map(
            (m) =>
              `- ID ${m.id}: **${m.name}** (slug: ${m.slug})\n` +
              `  Locations: ${m.locations?.length ? m.locations.join(", ") : "(none)"}\n` +
              `  Auto-add pages: ${m.auto_add ? "yes" : "no"}`,
          )
          .join("\n")
      );
    } catch (_error) {
      handleMenuError("wp_list_menus", "menus", _error);
    }
  }

  public async handleGetMenu(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = Number(params.id);
    try {
      const m = await client.getMenu(id);
      return (
        `**Menu: ${m.name}** (ID: ${m.id})\n` +
        `- Slug: ${m.slug}\n` +
        `- Description: ${m.description || "(none)"}\n` +
        `- Locations: ${m.locations?.length ? m.locations.join(", ") : "(none)"}\n` +
        `- Auto-add top-level pages: ${m.auto_add ? "yes" : "no"}`
      );
    } catch (_error) {
      handleMenuError(`wp_get_menu (id=${id})`, `menus/${id}`, _error);
    }
  }

  public async handleCreateMenu(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const name = String(params.name);
    try {
      const data = stripUndefined({
        name,
        slug: params.slug as string | undefined,
        description: params.description as string | undefined,
        auto_add: params.auto_add as boolean | undefined,
        locations: params.locations as string[] | undefined,
      }) as unknown as CreateMenuRequest;
      const m = await client.createMenu(data);
      return `✅ Menu created — ID: ${m.id}, Name: **${m.name}**, Slug: ${m.slug}`;
    } catch (_error) {
      handleMenuError("wp_create_menu", "menus", _error);
    }
  }

  public async handleUpdateMenu(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = Number(params.id);
    try {
      const data = stripUndefined({
        name: params.name as string | undefined,
        slug: params.slug as string | undefined,
        description: params.description as string | undefined,
        auto_add: params.auto_add as boolean | undefined,
        locations: params.locations as string[] | undefined,
      }) as unknown as UpdateMenuRequest;
      const m = await client.updateMenu(id, data);
      return `✅ Menu ${m.id} updated — Name: **${m.name}**, Locations: ${m.locations?.join(", ") || "(none)"}`;
    } catch (_error) {
      handleMenuError(`wp_update_menu (id=${id})`, `menus/${id}`, _error);
    }
  }

  public async handleDeleteMenu(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = Number(params.id);
    try {
      const result = await client.deleteMenu(id);
      const title = result.previous?.name ?? `ID ${id}`;
      return `✅ Menu "${title}" deleted.`;
    } catch (_error) {
      handleMenuError(`wp_delete_menu (id=${id})`, `menus/${id}`, _error);
    }
  }

  // ── Menu Item Handlers ────────────────────────────────────────────────────

  public async handleListMenuItems(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const {
      menus,
      per_page = 100,
      page,
      search,
      parent,
    } = params as {
      menus?: number;
      per_page?: number;
      page?: number;
      search?: string;
      parent?: number;
    };
    const query: Record<string, unknown> = { per_page };
    if (menus !== undefined) query.menus = menus;
    if (page !== undefined) query.page = page;
    if (search !== undefined) query.search = search;
    if (parent !== undefined) query.parent = parent;
    try {
      const items = await client.listMenuItems(
        query as { menus?: number; per_page?: number; page?: number; search?: string; parent?: number },
      );
      if (items.length === 0) return "No menu items found.";
      return (
        `Found ${items.length} menu item(s):\n\n` +
        items
          .map(
            (i) =>
              `- ID ${i.id}: **${i.title?.rendered ?? "(untitled)"}** → ${i.url || "(no URL)"}\n` +
              `  Type: ${i.type}, Order: ${i.menu_order}, Parent: ${i.parent}, Menu: ${i.menus}`,
          )
          .join("\n")
      );
    } catch (_error) {
      handleMenuError("wp_list_menu_items", "menu-items", _error);
    }
  }

  public async handleCreateMenuItem(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const menus = Number(params.menus);
    const title = String(params.title);
    try {
      const data = stripUndefined({
        menus,
        title,
        url: params.url as string | undefined,
        type: params.type as string | undefined,
        object: params.object as string | undefined,
        object_id: params.object_id as number | undefined,
        parent: params.parent as number | undefined,
        menu_order: params.menu_order as number | undefined,
        target: params.target as string | undefined,
        attr_title: params.attr_title as string | undefined,
        description: params.description as string | undefined,
        classes: params.classes as string[] | undefined,
        xfn: params.xfn as string[] | undefined,
        status: params.status as string | undefined,
      }) as unknown as CreateMenuItemRequest;
      // menus and title are always present
      data.menus = menus;
      data.title = title;
      const item = await client.createMenuItem(data);
      return `✅ Menu item created — ID: ${item.id}, Label: **${item.title?.rendered}**, URL: ${item.url || "(auto)"}`;
    } catch (_error) {
      handleMenuError("wp_create_menu_item", "menu-items", _error);
    }
  }

  public async handleUpdateMenuItem(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = Number(params.id);
    try {
      const data = stripUndefined({
        menus: params.menus as number | undefined,
        title: params.title as string | undefined,
        url: params.url as string | undefined,
        type: params.type as string | undefined,
        object: params.object as string | undefined,
        object_id: params.object_id as number | undefined,
        parent: params.parent as number | undefined,
        menu_order: params.menu_order as number | undefined,
        target: params.target as string | undefined,
        attr_title: params.attr_title as string | undefined,
        description: params.description as string | undefined,
        classes: params.classes as string[] | undefined,
        status: params.status as string | undefined,
      }) as unknown as UpdateMenuItemRequest;
      const item = await client.updateMenuItem(id, data);
      return `✅ Menu item ${item.id} updated — Label: **${item.title?.rendered}**, URL: ${item.url || "(auto)"}`;
    } catch (_error) {
      handleMenuError(`wp_update_menu_item (id=${id})`, `menu-items/${id}`, _error);
    }
  }

  public async handleDeleteMenuItem(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = Number(params.id);
    try {
      const result = await client.deleteMenuItem(id);
      const label = result.previous?.title?.rendered ?? `ID ${id}`;
      return `✅ Menu item "${label}" deleted.`;
    } catch (_error) {
      handleMenuError(`wp_delete_menu_item (id=${id})`, `menu-items/${id}`, _error);
    }
  }

  // ── Widget Handlers ───────────────────────────────────────────────────────

  public async handleListWidgets(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { sidebar } = params as { sidebar?: string };
    try {
      const widgets = await client.listWidgets(sidebar);
      if (widgets.length === 0)
        return sidebar ? `No widgets found in sidebar "${sidebar}".` : "No active widgets found.";
      return (
        `Found ${widgets.length} widget(s)${sidebar ? ` in sidebar "${sidebar}"` : ""}:\n\n` +
        widgets.map((w) => `- **${w.id}** (type: ${w.id_base}, sidebar: ${w.sidebar})`).join("\n")
      );
    } catch (_error) {
      handleMenuError("wp_list_widgets", "widgets", _error);
    }
  }

  public async handleGetWidget(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.id);
    try {
      const w = await client.getWidget(id);
      return (
        `**Widget: ${w.id}**\n` +
        `- Type: ${w.id_base}\n` +
        `- Sidebar: ${w.sidebar}\n` +
        `- Rendered preview (first 300 chars): ${(w.rendered || "(empty)").slice(0, 300)}`
      );
    } catch (_error) {
      handleMenuError(`wp_get_widget (id=${id})`, `widgets/${id}`, _error);
    }
  }

  public async handleUpdateWidget(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.id);
    const { sidebar, instance } = params as { sidebar?: string; instance?: Record<string, unknown> };
    try {
      const data: Record<string, unknown> = {};
      if (sidebar !== undefined) data.sidebar = sidebar;
      if (instance !== undefined) data.instance = instance;
      const w = await client.updateWidget(id, data);
      return `✅ Widget **${w.id}** updated (sidebar: ${w.sidebar}).`;
    } catch (_error) {
      handleMenuError(`wp_update_widget (id=${id})`, `widgets/${id}`, _error);
    }
  }

  // ── Sidebar Handlers ──────────────────────────────────────────────────────

  public async handleListSidebars(client: WordPressClient, _params: Record<string, unknown>): Promise<unknown> {
    try {
      const sidebars = await client.listSidebars();
      if (sidebars.length === 0) return "No widget areas (sidebars) found.";
      return (
        `Found ${sidebars.length} sidebar(s):\n\n` +
        sidebars
          .map(
            (s) =>
              `- **${s.id}**: ${s.name} (${s.status})\n` +
              `  ${s.description ? s.description : "(no description)"}\n` +
              `  Widgets: ${s.widgets?.length ?? 0}`,
          )
          .join("\n")
      );
    } catch (_error) {
      handleMenuError("wp_list_sidebars", "sidebars", _error);
    }
  }
}

export default MenuTools;
