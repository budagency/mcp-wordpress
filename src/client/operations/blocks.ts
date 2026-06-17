/**
 * Reusable Blocks Operations Module
 *
 * CRUD for WordPress reusable blocks — the `wp_block` custom post type, exposed
 * by WordPress core at the REST route `/wp/v2/blocks` (rest_base `blocks`).
 * Reusable blocks (a.k.a. "synced patterns" in the editor UI since WP 6.3) are a
 * fully core, no-plugin-required surface, so this is tractable on every site in
 * the fleet today.
 *
 * Route reference: https://developer.wordpress.org/rest-api/reference/blocks/
 *
 * Mirrors the shape of ./pages.ts and ./posts.ts so it slots into the existing
 * WordPressClient composition the same way (see src/client/api.ts).
 */

import type { WordPressRendered, WordPressMeta, PostStatus } from "@/types/wordpress.js";

/**
 * A reusable block (`wp_block`) as returned by `/wp/v2/blocks`.
 * `title`/`content` are rendered/raw objects exactly like posts and pages.
 */
export interface WordPressBlock {
  id: number;
  date: string;
  date_gmt: string;
  guid: WordPressRendered;
  modified: string;
  modified_gmt: string;
  slug: string;
  status: PostStatus;
  type: string;
  link: string;
  title: WordPressRendered;
  content: WordPressRendered;
  template: string;
  meta: WordPressMeta;
}

export interface BlockQueryParams {
  context?: "view" | "embed" | "edit";
  page?: number;
  per_page?: number;
  search?: string;
  slug?: string;
  status?: PostStatus | PostStatus[];
  orderby?: string;
  order?: "asc" | "desc";
}

export interface CreateBlockRequest {
  /** Block title (how it appears in the reusable-block list). */
  title: string;
  /** Block markup — Gutenberg delimited content. Build it with utils/blocks.serializeBlocks. */
  content?: string;
  status?: PostStatus;
  slug?: string;
  meta?: WordPressMeta;
}

export interface UpdateBlockRequest extends Partial<CreateBlockRequest> {
  id: number;
}

/**
 * Interface for the base client methods needed by block operations.
 * Identical to PagesClientBase — kept local so this file is drop-in.
 */
export interface BlocksClientBase {
  get<T>(endpoint: string): Promise<T>;
  post<T>(endpoint: string, data?: unknown): Promise<T>;
  put<T>(endpoint: string, data?: unknown): Promise<T>;
  delete<T>(endpoint: string): Promise<T>;
}

/**
 * Reusable-block operations mixin.
 * Provides CRUD operations for the `wp_block` post type via `/wp/v2/blocks`.
 */
export class BlocksOperations {
  constructor(private client: BlocksClientBase) {}

  /**
   * List reusable blocks with optional filtering.
   * Tip: pass `context: "edit"` to receive `content.raw` (the unrendered block markup).
   */
  async listBlocks(params?: BlockQueryParams): Promise<WordPressBlock[]> {
    const normalized = params
      ? Object.fromEntries(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined;
    const queryString = normalized ? "?" + new URLSearchParams(normalized).toString() : "";
    return this.client.get<WordPressBlock[]>(`blocks${queryString}`);
  }

  /**
   * Get a single reusable block by ID.
   * @param context Use "edit" to get `content.raw` for round-trip editing.
   */
  async getBlock(id: number, context: "view" | "embed" | "edit" = "view"): Promise<WordPressBlock> {
    return this.client.get<WordPressBlock>(`blocks/${id}?context=${context}`);
  }

  /**
   * Create a new reusable block.
   * WordPress documents POST as the create verb for `/wp/v2/blocks`.
   */
  async createBlock(data: CreateBlockRequest): Promise<WordPressBlock> {
    return this.client.post<WordPressBlock>("blocks", data);
  }

  /**
   * Update an existing reusable block. Only provided fields are changed.
   * WordPress accepts PUT/PATCH as aliases for the documented POST update verb;
   * we use PUT to match the posts/pages operations in this client.
   */
  async updateBlock(data: UpdateBlockRequest): Promise<WordPressBlock> {
    const { id, ...updateData } = data;
    return this.client.put<WordPressBlock>(`blocks/${id}`, updateData);
  }

  /**
   * Convenience wrapper to update only a block's content markup.
   */
  async updateBlockContent(id: number, content: string): Promise<WordPressBlock> {
    return this.client.put<WordPressBlock>(`blocks/${id}`, { content });
  }

  /**
   * Delete a reusable block.
   * @param force true = permanent delete; false = move to trash (default).
   */
  async deleteBlock(id: number, force = false): Promise<{ deleted: boolean; previous?: WordPressBlock }> {
    return this.client.delete(`blocks/${id}?force=${force}`);
  }
}
