/**
 * Menus, Menu Items, Widgets & Sidebars Operations Module
 *
 * Handles WP REST API v2 endpoints for nav menus, menu items, widgets, and
 * sidebars. All endpoints require WP 5.9+ and edit_theme_options capability.
 *
 * Endpoints:
 *   GET/POST/PUT/DELETE  wp/v2/menus[/<id>]
 *   GET/POST/PUT/DELETE  wp/v2/menu-items[/<id>]
 *   GET/PUT              wp/v2/widgets[/<id>]
 *   GET                  wp/v2/sidebars[/<id>]
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WordPressMenu {
  id: number;
  name: string;
  slug: string;
  description: string;
  auto_add: boolean;
  meta: unknown;
  locations: string[];
}

export interface WordPressMenuItem {
  id: number;
  title: { rendered: string; raw?: string };
  url: string;
  status: string;
  attr_title: string;
  description: string;
  type: string;
  type_label: string;
  object: string;
  object_id: number;
  parent: number;
  menu_order: number;
  target: string;
  classes: string[];
  xfn: string[];
  invalid: boolean;
  menus: number;
}

export interface WordPressWidget {
  id: string;
  id_base: string;
  sidebar: string;
  rendered: string;
  rendered_form?: string;
  instance?: { raw?: Record<string, unknown> };
}

export interface WordPressSidebar {
  id: string;
  name: string;
  description: string;
  class: string;
  before_widget: string;
  after_widget: string;
  before_title: string;
  after_title: string;
  status: "active" | "inactive";
  widgets: string[];
}

export interface CreateMenuRequest {
  name: string;
  slug?: string;
  description?: string;
  auto_add?: boolean;
  locations?: string[];
  meta?: unknown;
}

export interface UpdateMenuRequest {
  name?: string;
  slug?: string;
  description?: string;
  auto_add?: boolean;
  locations?: string[];
  meta?: unknown;
}

export interface CreateMenuItemRequest {
  title: string;
  url?: string;
  status?: string;
  attr_title?: string;
  description?: string;
  type?: string;
  type_label?: string;
  object?: string;
  object_id?: number;
  parent?: number;
  menu_order?: number;
  target?: string;
  classes?: string[];
  xfn?: string[];
  menus: number;
}

export interface UpdateMenuItemRequest {
  title?: string;
  url?: string;
  status?: string;
  attr_title?: string;
  description?: string;
  type?: string;
  object?: string;
  object_id?: number;
  parent?: number;
  menu_order?: number;
  target?: string;
  classes?: string[];
  xfn?: string[];
  menus?: number;
}

export interface MenuItemQueryParams {
  menus?: number;
  per_page?: number;
  page?: number;
  search?: string;
  parent?: number;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface MenusClientBase {
  get<T>(endpoint: string): Promise<T>;
  post<T>(endpoint: string, data?: unknown): Promise<T>;
  put<T>(endpoint: string, data?: unknown): Promise<T>;
  delete<T>(endpoint: string): Promise<T>;
}

// ---------------------------------------------------------------------------
// Operations class
// ---------------------------------------------------------------------------

export class MenusOperations {
  constructor(private client: MenusClientBase) {}

  // ── Menus ──────────────────────────────────────────────────────────────

  async listMenus(): Promise<WordPressMenu[]> {
    return this.client.get<WordPressMenu[]>("menus?per_page=100");
  }

  async getMenu(id: number): Promise<WordPressMenu> {
    return this.client.get<WordPressMenu>(`menus/${id}`);
  }

  async createMenu(data: CreateMenuRequest): Promise<WordPressMenu> {
    return this.client.post<WordPressMenu>("menus", data);
  }

  async updateMenu(id: number, data: UpdateMenuRequest): Promise<WordPressMenu> {
    return this.client.put<WordPressMenu>(`menus/${id}`, data);
  }

  async deleteMenu(id: number, force = true): Promise<{ deleted: boolean; previous?: WordPressMenu }> {
    return this.client.delete<{ deleted: boolean; previous?: WordPressMenu }>(`menus/${id}?force=${force}`);
  }

  // ── Menu Items ──────────────────────────────────────────────────────────

  async listMenuItems(params?: MenuItemQueryParams): Promise<WordPressMenuItem[]> {
    const query = params
      ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
      : "";
    return this.client.get<WordPressMenuItem[]>(`menu-items${query}`);
  }

  async createMenuItem(data: CreateMenuItemRequest): Promise<WordPressMenuItem> {
    return this.client.post<WordPressMenuItem>("menu-items", data);
  }

  async updateMenuItem(id: number, data: UpdateMenuItemRequest): Promise<WordPressMenuItem> {
    return this.client.put<WordPressMenuItem>(`menu-items/${id}`, data);
  }

  async deleteMenuItem(id: number, force = true): Promise<{ deleted: boolean; previous?: WordPressMenuItem }> {
    return this.client.delete<{ deleted: boolean; previous?: WordPressMenuItem }>(`menu-items/${id}?force=${force}`);
  }

  // ── Widgets ─────────────────────────────────────────────────────────────

  async listWidgets(sidebar?: string): Promise<WordPressWidget[]> {
    const query = sidebar ? `?sidebar=${encodeURIComponent(sidebar)}` : "";
    return this.client.get<WordPressWidget[]>(`widgets${query}`);
  }

  async getWidget(id: string): Promise<WordPressWidget> {
    return this.client.get<WordPressWidget>(`widgets/${encodeURIComponent(id)}`);
  }

  async updateWidget(id: string, data: Partial<WordPressWidget>): Promise<WordPressWidget> {
    return this.client.put<WordPressWidget>(`widgets/${encodeURIComponent(id)}`, data);
  }

  // ── Sidebars ────────────────────────────────────────────────────────────

  async listSidebars(): Promise<WordPressSidebar[]> {
    return this.client.get<WordPressSidebar[]>("sidebars");
  }

  async getSidebar(id: string): Promise<WordPressSidebar> {
    return this.client.get<WordPressSidebar>(`sidebars/${encodeURIComponent(id)}`);
  }
}
