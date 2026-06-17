/**
 * WordPress Content Editing Tools
 *
 * Provides partial find/replace editing for post and page content without
 * requiring the caller to pass the full body. Fetches raw content (context=edit),
 * applies the substitution, errors loudly if the find string is absent, and
 * PUTs only the content field back.
 *
 * Tools exported:
 *   wp_edit_post_content  — find/replace in a post's raw content
 *   wp_edit_page_content  — find/replace in a page's raw content
 */

import { WordPressClient } from "@/client/api.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { getErrorMessage } from "@/utils/error.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface EditContentParams {
  id: number;
  find: string;
  replace: string;
  regex?: boolean;
  /** Max number of replacements; 0 = replace all (default). */
  count?: number;
}

interface ApplyResult {
  newContent: string;
  occurrences: number;
}

// ---------------------------------------------------------------------------
// Core find/replace logic (shared by post and page handlers)
// ---------------------------------------------------------------------------

/**
 * Apply a literal or regex find/replace to the content string.
 * Returns the modified content and the number of substitutions made.
 */
function applyFindReplace(
  content: string,
  find: string,
  replace: string,
  useRegex: boolean,
  maxCount: number,
): ApplyResult {
  if (useRegex) {
    // Build a global regex; honour maxCount via a replacement counter
    let re: RegExp;
    try {
      re = new RegExp(find, "g");
    } catch (_err) {
      throw new Error(`Invalid regular expression: ${getErrorMessage(_err)}`);
    }

    let occurrences = 0;
    const newContent = content.replace(re, (match) => {
      if (maxCount > 0 && occurrences >= maxCount) return match;
      occurrences++;
      return replace;
    });
    return { newContent, occurrences };
  }

  // Literal string replacement with optional maxCount
  let result = content;
  let occurrences = 0;
  let searchFrom = 0;

  while (true) {
    const pos = result.indexOf(find, searchFrom);
    if (pos === -1) break;
    result = result.slice(0, pos) + replace + result.slice(pos + find.length);
    searchFrom = pos + replace.length;
    occurrences++;
    if (maxCount > 0 && occurrences >= maxCount) break;
  }

  return { newContent: result, occurrences };
}

/** Returns a short excerpt (first N chars) for the before/after diff summary. */
function excerpt(s: string, len = 200): string {
  return s.length > len ? s.slice(0, len) + "…" : s;
}

// ---------------------------------------------------------------------------
// ContentTools class
// ---------------------------------------------------------------------------

/**
 * Provides partial-content editing tools for WordPress posts and pages.
 *
 * Registration: add to src/tools/index.ts:
 *   export { default as ContentTools } from "./content.js";
 */
export class ContentTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    const sharedProperties = {
      id: {
        type: "number" as const,
        description: "The ID of the post/page whose content should be edited.",
      },
      find: {
        type: "string" as const,
        description:
          "The text to search for in the raw content. Must be present; an error is returned if not found (no silent no-op).",
      },
      replace: {
        type: "string" as const,
        description: "The replacement text.",
      },
      regex: {
        type: "boolean" as const,
        description:
          "If true, treat `find` as a regular expression (JS RegExp syntax). Default: false (literal match).",
      },
      count: {
        type: "number" as const,
        description:
          "Maximum number of replacements to make. 0 (default) = replace all occurrences. Set to 1 to replace only the first match.",
      },
    };

    return [
      {
        name: "wp_edit_post_content",
        description:
          "Performs a find/replace edit on a WordPress post's raw content without requiring the full body to be passed. " +
          "Fetches the raw Gutenberg/shortcode source (context=edit), applies the substitution, then PUTs only the content field. " +
          "Errors loudly if the find string is not present — no silent no-ops.\n\n" +
          "**Usage Examples:**\n" +
          '• Literal replace: `wp_edit_post_content --id=42 --find="old phrase" --replace="new phrase"`\n' +
          '• First match only: `wp_edit_post_content --id=42 --find="foo" --replace="bar" --count=1`\n' +
          '• Regex replace: `wp_edit_post_content --id=42 --find="\\\\b2023\\\\b" --replace="2024" --regex=true`',
        inputSchema: {
          type: "object",
          properties: sharedProperties,
          required: ["id", "find", "replace"],
        },
        handler: this.handleEditPostContent.bind(this),
      },
      {
        name: "wp_edit_page_content",
        description:
          "Performs a find/replace edit on a WordPress page's raw content without requiring the full body to be passed. " +
          "Fetches the raw Gutenberg/shortcode source (context=edit), applies the substitution, then PUTs only the content field. " +
          "Errors loudly if the find string is not present — no silent no-ops.\n\n" +
          "**Usage Examples:**\n" +
          '• Literal replace: `wp_edit_page_content --id=10 --find="old phrase" --replace="new phrase"`\n' +
          '• First match only: `wp_edit_page_content --id=10 --find="foo" --replace="bar" --count=1`\n' +
          '• Regex replace: `wp_edit_page_content --id=10 --find="\\\\b2023\\\\b" --replace="2024" --regex=true`',
        inputSchema: {
          type: "object",
          properties: sharedProperties,
          required: ["id", "find", "replace"],
        },
        handler: this.handleEditPageContent.bind(this),
      },

      // ── Revision Restore ──────────────────────────────────────────────────

      {
        name: "wp_restore_post_revision",
        description:
          "Restores a WordPress post to a previous revision. Fetches the revision's raw content " +
          "(title, content, excerpt) and PUTs it back to the parent post, creating a new revision " +
          "in the process. The current version is preserved as a revision — this is a safe rollback.\n\n" +
          "**Workflow:** 1) Call wp_get_post_revisions --id=<post_id> to list revisions with their IDs. " +
          "2) Call wp_restore_post_revision --post_id=<post_id> --revision_id=<rev_id> to restore.\n\n" +
          "Requires: authentication as editor or administrator.",
        inputSchema: {
          type: "object",
          properties: {
            post_id: {
              type: "number",
              description: "The ID of the parent post to restore.",
            },
            revision_id: {
              type: "number",
              description: "The revision ID to restore from (obtained via wp_get_post_revisions).",
            },
          },
          required: ["post_id", "revision_id"],
        },
        handler: this.handleRestorePostRevision.bind(this),
      },
      {
        name: "wp_restore_page_revision",
        description:
          "Restores a WordPress page to a previous revision. Fetches the revision's raw content " +
          "(title, content, excerpt) and PUTs it back to the parent page. The current version is " +
          "preserved as a revision — this is a safe rollback.\n\n" +
          "**Workflow:** 1) Call wp_get_page_revisions --id=<page_id> to list revisions with their IDs. " +
          "2) Call wp_restore_page_revision --page_id=<page_id> --revision_id=<rev_id> to restore.\n\n" +
          "Requires: authentication as editor or administrator.",
        inputSchema: {
          type: "object",
          properties: {
            page_id: {
              type: "number",
              description: "The ID of the parent page to restore.",
            },
            revision_id: {
              type: "number",
              description: "The revision ID to restore from (obtained via wp_get_page_revisions).",
            },
          },
          required: ["page_id", "revision_id"],
        },
        handler: this.handleRestorePageRevision.bind(this),
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Post content edit
  // ---------------------------------------------------------------------------

  public async handleEditPostContent(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { id, find, replace, regex, count } = this.parseParams(params, "post");
    try {
      // Fetch raw content via context=edit
      const post = await client.getPost(id, "edit");
      const rawContent = post.content?.raw;

      if (rawContent === undefined || rawContent === null) {
        throw new Error(
          "Could not retrieve raw content for post. " +
            "The site may not support context=edit for this endpoint, or the user lacks editor/admin privileges.",
        );
      }

      // Validate find string is present before mutating
      this.assertFindPresent(rawContent, find, regex, "post");

      const { newContent, occurrences } = applyFindReplace(rawContent, find, replace, regex, count);

      // PUT only the content field — don't touch title/status/etc.
      await client.updatePost({ id, content: newContent });

      return this.buildSummary("post", id, find, replace, occurrences, rawContent, newContent);
    } catch (_error) {
      throw new Error(`wp_edit_post_content failed: ${getErrorMessage(_error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Page content edit
  // ---------------------------------------------------------------------------

  public async handleEditPageContent(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const { id, find, replace, regex, count } = this.parseParams(params, "page");
    try {
      // Fetch raw content via context=edit
      const page = await client.getPage(id, "edit");
      const rawContent = page.content?.raw;

      if (rawContent === undefined || rawContent === null) {
        throw new Error(
          "Could not retrieve raw content for page. " +
            "The site may not support context=edit for this endpoint, or the user lacks editor/admin privileges.",
        );
      }

      // Validate find string is present before mutating
      this.assertFindPresent(rawContent, find, regex, "page");

      const { newContent, occurrences } = applyFindReplace(rawContent, find, replace, regex, count);

      // PUT only the content field
      await client.updatePage({ id, content: newContent });

      return this.buildSummary("page", id, find, replace, occurrences, rawContent, newContent);
    } catch (_error) {
      throw new Error(`wp_edit_page_content failed: ${getErrorMessage(_error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Revision restore
  // ---------------------------------------------------------------------------

  public async handleRestorePostRevision(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const postId = Number(params.post_id);
    const revisionId = Number(params.revision_id);
    if (!postId || postId <= 0) throw new Error('wp_restore_post_revision: "post_id" must be a positive integer.');
    if (!revisionId || revisionId <= 0)
      throw new Error('wp_restore_post_revision: "revision_id" must be a positive integer.');
    try {
      const updated = await client.restorePostRevision(postId, revisionId);
      return (
        `✅ Post ${postId} restored to revision ${revisionId}.\n` +
        `Title: ${updated.title?.rendered ?? "(unchanged)"}\n` +
        `Status: ${updated.status}\n` +
        `Modified: ${updated.modified}`
      );
    } catch (_error) {
      throw new Error(`wp_restore_post_revision failed: ${getErrorMessage(_error)}`);
    }
  }

  public async handleRestorePageRevision(client: WordPressClient, params: Record<string, unknown>): Promise<unknown> {
    const pageId = Number(params.page_id);
    const revisionId = Number(params.revision_id);
    if (!pageId || pageId <= 0) throw new Error('wp_restore_page_revision: "page_id" must be a positive integer.');
    if (!revisionId || revisionId <= 0)
      throw new Error('wp_restore_page_revision: "revision_id" must be a positive integer.');
    try {
      const updated = await client.restorePageRevision(pageId, revisionId);
      return (
        `✅ Page ${pageId} restored to revision ${revisionId}.\n` +
        `Title: ${updated.title?.rendered ?? "(unchanged)"}\n` +
        `Status: ${updated.status}\n` +
        `Modified: ${updated.modified}`
      );
    } catch (_error) {
      throw new Error(`wp_restore_page_revision failed: ${getErrorMessage(_error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private parseParams(params: Record<string, unknown>, type: string): Required<EditContentParams> {
    const id = Number(params.id);
    if (!id || id <= 0) throw new Error(`wp_edit_${type}_content: "id" must be a positive integer.`);

    const find = typeof params.find === "string" ? params.find : undefined;
    if (find === undefined) throw new Error(`wp_edit_${type}_content: "find" (string) is required.`);

    const replace = typeof params.replace === "string" ? params.replace : undefined;
    if (replace === undefined) throw new Error(`wp_edit_${type}_content: "replace" (string) is required.`);

    const regex: boolean = params.regex === true;
    const count: number = params.count !== undefined ? Number(params.count) : 0;
    if (count < 0) throw new Error(`wp_edit_${type}_content: "count" must be 0 (replace-all) or a positive integer.`);

    return { id, find, replace, regex, count };
  }

  private assertFindPresent(content: string, find: string, useRegex: boolean, type: string): void {
    if (useRegex) {
      let re: RegExp;
      try {
        re = new RegExp(find);
      } catch (_err) {
        throw new Error(`Invalid regular expression: ${getErrorMessage(_err)}`);
      }
      if (!re.test(content)) {
        throw new Error(
          `Find pattern not found in ${type} content — no changes made.\n` +
            `Pattern (regex): ${find}\n` +
            `Content preview: ${excerpt(content, 300)}`,
        );
      }
    } else {
      if (!content.includes(find)) {
        throw new Error(
          `Find string not found in ${type} content — no changes made.\n` +
            `Find: ${JSON.stringify(find)}\n` +
            `Content preview: ${excerpt(content, 300)}`,
        );
      }
    }
  }

  private buildSummary(
    type: string,
    id: number,
    find: string,
    replace: string,
    occurrences: number,
    before: string,
    after: string,
  ): string {
    return (
      `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} ${id} content updated.\n` +
      `Replacements made: ${occurrences}\n\n` +
      `Find:    ${excerpt(find, 100)}\n` +
      `Replace: ${excerpt(replace, 100)}\n\n` +
      `Before (first 200 chars):\n${excerpt(before, 200)}\n\n` +
      `After (first 200 chars):\n${excerpt(after, 200)}`
    );
  }
}

export default ContentTools;
