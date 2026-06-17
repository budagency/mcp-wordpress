/**
 * WordPress Reusable-Block Tools — PROTOTYPE (NOT WIRED).
 *
 * ⚠️  This class is intentionally NOT exported from src/tools/index.ts, so it is
 *     not registered by ToolRegistry and not live in the MCP. It is a reviewable
 *     prototype for the ACF/blocks spike (gap #6). Wiring instructions are in
 *     docs/ACF_BLOCKS_SPIKE.md (add the barrel export + a smoke test, then build).
 *
 * It demonstrates two capabilities:
 *   1. CRUD over reusable blocks (`wp_block` CPT) via /wp/v2/blocks — fully core,
 *      no per-site plugin required. Backed by src/client/operations/blocks.ts.
 *   2. Structural inspection of Gutenberg block markup via src/utils/blocks.ts
 *      (parse -> tree), with no headless browser.
 *
 * The handlers instantiate BlocksOperations against the standard client's
 * get/post/put/delete methods, so they work WITHOUT modifying WordPressClient.
 */

import { WordPressClient } from "@/client/api.js";
import {
  BlocksOperations,
  type BlockQueryParams,
  type CreateBlockRequest,
  type UpdateBlockRequest,
} from "@/client/operations/blocks.js";
import { parseBlocks, type BlockNode } from "@/utils/blocks.js";
import { getErrorMessage } from "@/utils/error.js";
import { validateId } from "@/utils/validation/core.js";
import type { MCPTool } from "@/types/mcp.js";

const listBlocksTool: MCPTool = {
  name: "wp_list_blocks",
  description:
    "Lists reusable blocks (the wp_block post type / 'synced patterns') from a WordPress site via /wp/v2/blocks. Core capability, no plugin required.",
  inputSchema: {
    type: "object",
    properties: {
      per_page: { type: "number", description: "Number of items to return per page (max 100)." },
      search: { type: "string", description: "Limit results to those matching a search term." },
      status: {
        type: "string",
        description: "Filter by status.",
        enum: ["publish", "draft", "pending", "private"],
      },
    },
  },
};

const getBlockTool: MCPTool = {
  name: "wp_get_block",
  description:
    "Retrieves a single reusable block including its raw Gutenberg markup (context=edit) and a parsed structural summary of the blocks it contains.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "The reusable block ID." },
    },
    required: ["id"],
  },
};

const createBlockTool: MCPTool = {
  name: "wp_create_block",
  description: "Creates a new reusable block (wp_block). Provide Gutenberg-delimited markup as `content`.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Title shown in the reusable-block list." },
      content: { type: "string", description: "Block markup (Gutenberg delimited HTML)." },
      status: { type: "string", enum: ["publish", "draft", "pending", "private"], description: "Publish status." },
    },
    required: ["title"],
  },
};

const updateBlockTool: MCPTool = {
  name: "wp_update_block",
  description: "Updates an existing reusable block. Only provided fields change.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "The reusable block ID." },
      title: { type: "string", description: "New title." },
      content: { type: "string", description: "New block markup (Gutenberg delimited HTML)." },
      status: { type: "string", enum: ["publish", "draft", "pending", "private"], description: "New status." },
    },
    required: ["id"],
  },
};

const inspectBlocksTool: MCPTool = {
  name: "wp_inspect_blocks",
  description:
    "Parses arbitrary Gutenberg post_content into a structural outline (block names, nesting, counts) WITHOUT a headless browser. Use to understand a page's block structure before editing.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "Raw post_content (the content.raw field from a context=edit fetch)." },
    },
    required: ["content"],
  },
};

/** Render a parsed block tree as an indented outline for human/agent reading. */
function outlineBlocks(blocks: BlockNode[], depth = 0): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.blockName === null) {
      const ws = b.innerHTML.trim().length === 0;
      if (ws) continue; // skip pure inter-block whitespace in the outline
      lines.push(`${"  ".repeat(depth)}- (freeform/classic HTML, ${b.innerHTML.length} chars)`);
      continue;
    }
    const attrKeys = Object.keys(b.attrs);
    const attrNote = attrKeys.length ? ` {${attrKeys.join(", ")}}` : "";
    lines.push(`${"  ".repeat(depth)}- ${b.blockName}${attrNote}`);
    if (b.innerBlocks.length) lines.push(outlineBlocks(b.innerBlocks, depth + 1));
  }
  return lines.filter(Boolean).join("\n");
}

export class BlockTools {
  public getTools(): unknown[] {
    return [listBlocksTool, getBlockTool, createBlockTool, updateBlockTool, inspectBlocksTool].map((def) => ({
      ...def,
      handler: this.getHandlerForTool(def.name),
    }));
  }

  private getHandlerForTool(name: string) {
    switch (name) {
      case "wp_list_blocks":
        return this.handleListBlocks.bind(this);
      case "wp_get_block":
        return this.handleGetBlock.bind(this);
      case "wp_create_block":
        return this.handleCreateBlock.bind(this);
      case "wp_update_block":
        return this.handleUpdateBlock.bind(this);
      case "wp_inspect_blocks":
        return this.handleInspectBlocks.bind(this);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  public async handleListBlocks(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const ops = new BlocksOperations(client);
      const query: BlockQueryParams = { per_page: (params.per_page as number) ?? 20 };
      if (params.search !== undefined) query.search = params.search as string;
      if (params.status !== undefined) query.status = params.status as NonNullable<BlockQueryParams["status"]>;
      const blocks = await ops.listBlocks(query);
      if (!blocks.length) return "No reusable blocks found.";
      return (
        `🧱 **Reusable Blocks** (${blocks.length})\n\n` +
        blocks.map((b) => `- ID ${b.id}: **${b.title.rendered}** (${b.status})`).join("\n")
      );
    } catch (error) {
      throw new Error(`Failed to list reusable blocks: ${getErrorMessage(error)}`);
    }
  }

  public async handleGetBlock(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const id = validateId(params.id, "block ID");
      const ops = new BlocksOperations(client);
      const block = await ops.getBlock(id, "edit");
      const raw = block.content?.raw ?? block.content?.rendered ?? "";
      const tree = parseBlocks(raw);
      let out = `# ${block.title?.rendered || block.title?.raw || `Block ${id}`}\n\n`;
      out += `**ID**: ${block.id}\n**Status**: ${block.status}\n**Slug**: ${block.slug}\n\n`;
      out += `## Structure\n${outlineBlocks(tree) || "(no recognizable blocks)"}\n\n`;
      out += `## Raw markup\n\`\`\`html\n${raw}\n\`\`\`\n`;
      return out;
    } catch (error) {
      throw new Error(`Failed to get reusable block: ${getErrorMessage(error)}`);
    }
  }

  public async handleCreateBlock(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const data: CreateBlockRequest = { title: params.title as string };
      if (params.content !== undefined) data.content = params.content as string;
      if (params.status !== undefined) data.status = params.status as never;
      const ops = new BlocksOperations(client);
      const block = await ops.createBlock(data);
      return `✅ **Reusable block created**\n\n**Title**: ${block.title.rendered}\n**ID**: ${block.id}\n**Status**: ${block.status}`;
    } catch (error) {
      throw new Error(`Failed to create reusable block: ${getErrorMessage(error)}`);
    }
  }

  public async handleUpdateBlock(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const id = validateId(params.id, "block ID");
      const data: UpdateBlockRequest = { id };
      if (params.title !== undefined) data.title = params.title as string;
      if (params.content !== undefined) data.content = params.content as string;
      if (params.status !== undefined) data.status = params.status as never;
      const ops = new BlocksOperations(client);
      const block = await ops.updateBlock(data);
      return `✅ **Reusable block updated**\n\n**Title**: ${block.title.rendered}\n**ID**: ${block.id}\n**Status**: ${block.status}`;
    } catch (error) {
      throw new Error(`Failed to update reusable block: ${getErrorMessage(error)}`);
    }
  }

  public async handleInspectBlocks(_client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const content = (params.content as string) ?? "";
      const tree = parseBlocks(content);
      const outline = outlineBlocks(tree);
      return `## Block structure\n${outline || "(no recognizable blocks — content may be classic/freeform HTML)"}`;
    } catch (error) {
      throw new Error(`Failed to inspect blocks: ${getErrorMessage(error)}`);
    }
  }
}

export default BlockTools;
