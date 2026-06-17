/**
 * Tests for MenuTools — wp_list_menus, wp_get_menu, wp_create_menu, wp_update_menu,
 * wp_delete_menu, wp_list_menu_items, wp_create_menu_item, wp_update_menu_item,
 * wp_delete_menu_item, wp_list_widgets, wp_get_widget, wp_update_widget,
 * wp_list_sidebars.
 *
 * Mirrors the style of tests/tools/auth.test.js and tests/tools/content.test.js.
 */
import { vi } from "vitest";
import { MenuTools } from "@/tools/menus.js";

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------

function makeClient(overrides = {}) {
  return {
    listMenus: vi.fn(),
    getMenu: vi.fn(),
    createMenu: vi.fn(),
    updateMenu: vi.fn(),
    deleteMenu: vi.fn(),
    listMenuItems: vi.fn(),
    createMenuItem: vi.fn(),
    updateMenuItem: vi.fn(),
    deleteMenuItem: vi.fn(),
    listWidgets: vi.fn(),
    getWidget: vi.fn(),
    updateWidget: vi.fn(),
    listSidebars: vi.fn(),
    getSiteUrl: vi.fn().mockReturnValue("https://test.example.com"),
    config: { baseUrl: "https://test.example.com", auth: { method: "app-password" } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getTools
// ---------------------------------------------------------------------------

describe("MenuTools.getTools", () => {
  it("returns exactly 13 tools", () => {
    const mt = new MenuTools();
    expect(mt.getTools()).toHaveLength(13);
  });

  it("every tool has name, description, inputSchema, and handler", () => {
    const mt = new MenuTools();
    mt.getTools().forEach((tool) => {
      expect(typeof tool.name).toBe("string");
      expect(tool.name).toMatch(/^wp_/);
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    });
  });

  it("contains exactly the expected tool names", () => {
    const mt = new MenuTools();
    const names = mt.getTools().map((t) => t.name);
    const expected = [
      "wp_list_menus",
      "wp_get_menu",
      "wp_create_menu",
      "wp_update_menu",
      "wp_delete_menu",
      "wp_list_menu_items",
      "wp_create_menu_item",
      "wp_update_menu_item",
      "wp_delete_menu_item",
      "wp_list_widgets",
      "wp_get_widget",
      "wp_update_widget",
      "wp_list_sidebars",
    ];
    expected.forEach((name) => expect(names).toContain(name));
  });

  it("tools that take a mandatory id have it in required[]", () => {
    const mt = new MenuTools();
    const tools = mt.getTools();
    ["wp_get_menu", "wp_update_menu", "wp_delete_menu"].forEach((name) => {
      const tool = tools.find((t) => t.name === name);
      expect(tool.inputSchema.required).toContain("id");
    });
  });
});

// ---------------------------------------------------------------------------
// wp_list_menus
// ---------------------------------------------------------------------------

describe("MenuTools.handleListMenus", () => {
  it("returns a formatted list when menus exist", async () => {
    const client = makeClient({
      listMenus: vi.fn().mockResolvedValue([
        { id: 1, name: "Primary", slug: "primary", description: "", locations: ["primary"], auto_add: false },
        { id: 2, name: "Footer", slug: "footer", description: "Footer nav", locations: [], auto_add: true },
      ]),
    });
    const mt = new MenuTools();
    const result = await mt.handleListMenus(client, {});

    expect(client.listMenus).toHaveBeenCalledOnce();
    expect(result).toContain("2 nav menu(s)");
    expect(result).toContain("Primary");
    expect(result).toContain("Footer");
  });

  it("returns empty message when no menus exist", async () => {
    const client = makeClient({ listMenus: vi.fn().mockResolvedValue([]) });
    const mt = new MenuTools();
    const result = await mt.handleListMenus(client, {});
    expect(result).toContain("No nav menus found");
  });

  it("surfaces a capability error on 403", async () => {
    const client = makeClient({ listMenus: vi.fn().mockRejectedValue(new Error("403 Forbidden")) });
    const mt = new MenuTools();
    await expect(mt.handleListMenus(client, {})).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// wp_get_menu
// ---------------------------------------------------------------------------

describe("MenuTools.handleGetMenu", () => {
  it("returns details for a given menu id", async () => {
    const client = makeClient({
      getMenu: vi.fn().mockResolvedValue({
        id: 3,
        name: "Social",
        slug: "social",
        description: "Social links",
        locations: [],
        auto_add: false,
      }),
    });
    const mt = new MenuTools();
    const result = await mt.handleGetMenu(client, { id: 3 });

    expect(client.getMenu).toHaveBeenCalledWith(3);
    expect(result).toContain("Social");
    expect(result).toContain("social");
  });

  it("surfaces capability error on 404", async () => {
    const client = makeClient({ getMenu: vi.fn().mockRejectedValue(new Error("404 Not Found")) });
    const mt = new MenuTools();
    await expect(mt.handleGetMenu(client, { id: 99 })).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// wp_create_menu
// ---------------------------------------------------------------------------

describe("MenuTools.handleCreateMenu", () => {
  it("creates a menu and returns success message", async () => {
    const client = makeClient({
      createMenu: vi.fn().mockResolvedValue({ id: 5, name: "New Menu", slug: "new-menu" }),
    });
    const mt = new MenuTools();
    const result = await mt.handleCreateMenu(client, { name: "New Menu" });

    expect(client.createMenu).toHaveBeenCalledOnce();
    expect(result).toContain("✅ Menu created");
    expect(result).toContain("New Menu");
    expect(result).toContain("new-menu");
  });

  it("only passes defined optional fields to client (no undefined keys)", async () => {
    const client = makeClient({
      createMenu: vi.fn().mockResolvedValue({ id: 6, name: "Minimal", slug: "minimal" }),
    });
    const mt = new MenuTools();
    await mt.handleCreateMenu(client, { name: "Minimal" });

    const callArg = client.createMenu.mock.calls[0][0];
    expect(callArg).toHaveProperty("name", "Minimal");
    // Optional fields not passed should be absent (not undefined)
    expect("slug" in callArg).toBe(false);
    expect("description" in callArg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wp_update_menu
// ---------------------------------------------------------------------------

describe("MenuTools.handleUpdateMenu", () => {
  it("updates a menu and returns success message", async () => {
    const client = makeClient({
      updateMenu: vi.fn().mockResolvedValue({ id: 2, name: "Renamed", slug: "renamed", locations: ["footer"] }),
    });
    const mt = new MenuTools();
    const result = await mt.handleUpdateMenu(client, { id: 2, name: "Renamed" });

    expect(client.updateMenu).toHaveBeenCalledWith(2, expect.objectContaining({}));
    expect(result).toContain("✅ Menu 2 updated");
    expect(result).toContain("Renamed");
  });
});

// ---------------------------------------------------------------------------
// wp_delete_menu
// ---------------------------------------------------------------------------

describe("MenuTools.handleDeleteMenu", () => {
  it("deletes a menu and returns success message", async () => {
    const client = makeClient({
      deleteMenu: vi.fn().mockResolvedValue({ deleted: true, previous: { name: "Old Menu" } }),
    });
    const mt = new MenuTools();
    const result = await mt.handleDeleteMenu(client, { id: 1 });

    expect(client.deleteMenu).toHaveBeenCalledWith(1);
    expect(result).toContain("✅ Menu");
    expect(result).toContain("deleted");
  });
});

// ---------------------------------------------------------------------------
// wp_list_menu_items
// ---------------------------------------------------------------------------

describe("MenuTools.handleListMenuItems", () => {
  it("returns formatted list of menu items", async () => {
    const client = makeClient({
      listMenuItems: vi.fn().mockResolvedValue([
        { id: 10, title: { rendered: "Home" }, url: "https://example.com/", menus: 1, menu_order: 1, parent: 0 },
        { id: 11, title: { rendered: "About" }, url: "https://example.com/about/", menus: 1, menu_order: 2, parent: 0 },
      ]),
    });
    const mt = new MenuTools();
    const result = await mt.handleListMenuItems(client, { menus: 1 });

    expect(client.listMenuItems).toHaveBeenCalled();
    expect(result).toContain("Home");
    expect(result).toContain("About");
  });

  it("returns empty message when no items", async () => {
    const client = makeClient({ listMenuItems: vi.fn().mockResolvedValue([]) });
    const mt = new MenuTools();
    const result = await mt.handleListMenuItems(client, {});
    expect(result).toContain("No menu items");
  });
});

// ---------------------------------------------------------------------------
// wp_create_menu_item
// ---------------------------------------------------------------------------

describe("MenuTools.handleCreateMenuItem", () => {
  it("creates a menu item and returns success message", async () => {
    const client = makeClient({
      createMenuItem: vi.fn().mockResolvedValue({
        id: 20,
        title: { rendered: "Contact" },
        url: "https://example.com/contact/",
      }),
    });
    const mt = new MenuTools();
    const result = await mt.handleCreateMenuItem(client, {
      menus: 1,
      title: "Contact",
      url: "https://example.com/contact/",
    });

    expect(client.createMenuItem).toHaveBeenCalledOnce();
    const callArg = client.createMenuItem.mock.calls[0][0];
    expect(callArg.menus).toBe(1);
    expect(callArg.title).toBe("Contact");
    expect(result).toContain("✅ Menu item created");
    expect(result).toContain("Contact");
  });

  it("does not include undefined optional keys in the call payload", async () => {
    const client = makeClient({
      createMenuItem: vi.fn().mockResolvedValue({ id: 21, title: { rendered: "Blog" }, url: "" }),
    });
    const mt = new MenuTools();
    await mt.handleCreateMenuItem(client, { menus: 1, title: "Blog" });

    const callArg = client.createMenuItem.mock.calls[0][0];
    // url not passed → should not be in payload
    expect("url" in callArg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wp_update_menu_item
// ---------------------------------------------------------------------------

describe("MenuTools.handleUpdateMenuItem", () => {
  it("updates a menu item and returns success message", async () => {
    const client = makeClient({
      updateMenuItem: vi.fn().mockResolvedValue({
        id: 15,
        title: { rendered: "New Label" },
        url: "https://example.com/new/",
      }),
    });
    const mt = new MenuTools();
    const result = await mt.handleUpdateMenuItem(client, { id: 15, title: "New Label" });

    expect(client.updateMenuItem).toHaveBeenCalledWith(15, expect.any(Object));
    expect(result).toContain("✅ Menu item 15 updated");
    expect(result).toContain("New Label");
  });
});

// ---------------------------------------------------------------------------
// wp_delete_menu_item
// ---------------------------------------------------------------------------

describe("MenuTools.handleDeleteMenuItem", () => {
  it("deletes a menu item and returns success message", async () => {
    const client = makeClient({
      deleteMenuItem: vi.fn().mockResolvedValue({ deleted: true, previous: { title: { rendered: "Old Item" } } }),
    });
    const mt = new MenuTools();
    const result = await mt.handleDeleteMenuItem(client, { id: 10 });

    expect(client.deleteMenuItem).toHaveBeenCalledWith(10);
    expect(result).toContain("Old Item");
    expect(result).toContain("deleted");
  });
});

// ---------------------------------------------------------------------------
// wp_list_widgets
// ---------------------------------------------------------------------------

describe("MenuTools.handleListWidgets", () => {
  it("returns formatted list of widgets", async () => {
    const client = makeClient({
      listWidgets: vi.fn().mockResolvedValue([
        { id: "search-1", id_base: "search", sidebar: "sidebar-1", rendered: "<div>Search</div>" },
        { id: "recent-posts-1", id_base: "recent-posts", sidebar: "sidebar-1", rendered: "" },
      ]),
    });
    const mt = new MenuTools();
    const result = await mt.handleListWidgets(client, {});

    expect(client.listWidgets).toHaveBeenCalledWith(undefined);
    expect(result).toContain("search-1");
    expect(result).toContain("recent-posts-1");
  });

  it("filters by sidebar when provided", async () => {
    const client = makeClient({ listWidgets: vi.fn().mockResolvedValue([]) });
    const mt = new MenuTools();
    const result = await mt.handleListWidgets(client, { sidebar: "footer-1" });

    expect(client.listWidgets).toHaveBeenCalledWith("footer-1");
    expect(result).toContain("footer-1");
  });

  it("returns empty message when no widgets", async () => {
    const client = makeClient({ listWidgets: vi.fn().mockResolvedValue([]) });
    const mt = new MenuTools();
    const result = await mt.handleListWidgets(client, {});
    expect(result).toContain("No active widgets found");
  });
});

// ---------------------------------------------------------------------------
// wp_get_widget
// ---------------------------------------------------------------------------

describe("MenuTools.handleGetWidget", () => {
  it("returns widget details", async () => {
    const client = makeClient({
      getWidget: vi.fn().mockResolvedValue({
        id: "search-1",
        id_base: "search",
        sidebar: "sidebar-1",
        rendered: "<div>Search box</div>",
      }),
    });
    const mt = new MenuTools();
    const result = await mt.handleGetWidget(client, { id: "search-1" });

    expect(client.getWidget).toHaveBeenCalledWith("search-1");
    expect(result).toContain("search-1");
    expect(result).toContain("Search box");
  });
});

// ---------------------------------------------------------------------------
// wp_update_widget
// ---------------------------------------------------------------------------

describe("MenuTools.handleUpdateWidget", () => {
  it("updates a widget sidebar and returns success message", async () => {
    const client = makeClient({
      updateWidget: vi.fn().mockResolvedValue({
        id: "text-1",
        id_base: "text",
        sidebar: "footer-1",
        rendered: "<div>Hello</div>",
      }),
    });
    const mt = new MenuTools();
    const result = await mt.handleUpdateWidget(client, { id: "text-1", sidebar: "footer-1" });

    expect(client.updateWidget).toHaveBeenCalledWith("text-1", { sidebar: "footer-1" });
    expect(result).toContain("✅ Widget");
    expect(result).toContain("text-1");
    expect(result).toContain("footer-1");
  });

  it("passes only defined fields (omits undefined sidebar/instance)", async () => {
    const client = makeClient({
      updateWidget: vi.fn().mockResolvedValue({ id: "search-1", sidebar: "sidebar-1", rendered: "" }),
    });
    const mt = new MenuTools();
    await mt.handleUpdateWidget(client, { id: "search-1" });

    const callArg = client.updateWidget.mock.calls[0][1];
    expect("sidebar" in callArg).toBe(false);
    expect("instance" in callArg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wp_list_sidebars
// ---------------------------------------------------------------------------

describe("MenuTools.handleListSidebars", () => {
  it("returns formatted list of sidebars", async () => {
    const client = makeClient({
      listSidebars: vi.fn().mockResolvedValue([
        { id: "sidebar-1", name: "Main Sidebar", description: "Primary sidebar", status: "active" },
        { id: "footer-1", name: "Footer Widgets", description: "", status: "active" },
      ]),
    });
    const mt = new MenuTools();
    const result = await mt.handleListSidebars(client, {});

    expect(client.listSidebars).toHaveBeenCalledOnce();
    expect(result).toContain("2 sidebar(s)");
    expect(result).toContain("Main Sidebar");
    expect(result).toContain("Footer Widgets");
  });

  it("returns empty message when no sidebars", async () => {
    const client = makeClient({ listSidebars: vi.fn().mockResolvedValue([]) });
    const mt = new MenuTools();
    const result = await mt.handleListSidebars(client, {});
    expect(result).toContain("No widget areas (sidebars) found");
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — 403 / 404 capability errors
// ---------------------------------------------------------------------------

describe("MenuTools — graceful 403/404 degradation", () => {
  it.each([
    ["handleListMenus", "listMenus", {}],
    ["handleGetMenu", "getMenu", { id: 1 }],
    ["handleCreateMenu", "createMenu", { name: "X" }],
    ["handleListMenuItems", "listMenuItems", {}],
    ["handleListWidgets", "listWidgets", {}],
    ["handleListSidebars", "listSidebars", {}],
  ])("%s surfaces a clear capability error on 403", async (handler, clientMethod, params) => {
    const client = makeClient({
      [clientMethod]: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
    });
    const mt = new MenuTools();
    await expect(mt[handler](client, params)).rejects.toThrow(/edit_theme_options|WordPress 5\.9\+|403/);
  });
});
