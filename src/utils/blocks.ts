/**
 * Gutenberg Block (de)serialization — pure functions, no DOM / headless browser.
 *
 * WordPress stores block-structured post content as HTML annotated with
 * "block delimiter" HTML comments, e.g.
 *
 *   <!-- wp:paragraph {"align":"center"} -->
 *   <p class="has-text-align-center">Hello</p>
 *   <!-- /wp:paragraph -->
 *
 * This module parses that markup into a structured tree and serializes a tree
 * back to markup. It is a faithful TypeScript port of the algorithm used by
 * `@wordpress/block-serialization-default-parser`, reproduced here so the MCP
 * has zero runtime dependency on the (browser-oriented) @wordpress/* packages.
 *
 * Grammar reference:
 *   https://developer.wordpress.org/block-editor/getting-started/fundamentals/markup-representation-block/
 * Parser shape reference:
 *   https://developer.wordpress.org/block-editor/reference-guides/packages/packages-block-serialization-default-parser/
 *
 * Round-trip contract: for *canonical* WordPress markup (what the REST API
 * returns), `serializeBlocks(parseBlocks(html))` reproduces the input byte for
 * byte, except that an explicit `core/` namespace in a delimiter is normalized
 * to the canonical short form (`<!-- wp:core/paragraph -->` -> `<!-- wp:paragraph -->`),
 * which is what WordPress itself emits. The transform is therefore idempotent
 * after the first pass. See tests/utils/blocks.test.js for the proofs.
 */

/**
 * A single parsed block. Shape matches @wordpress/block-serialization-default-parser
 * exactly so trees are interchangeable with the upstream package if it is ever added.
 */
export interface BlockNode {
  /**
   * Fully-qualified block name, e.g. `core/paragraph`, `acf/testimonial`,
   * `woocommerce/cart`. Core blocks are namespaced to `core/` even though the
   * delimiter omits it. `null` represents "freeform" / classic-editor HTML and
   * inter-block whitespace (which the parser captures as freeform nodes).
   */
  blockName: string | null;
  /** Parsed JSON attributes from the opening delimiter. `{}` when none were present. */
  attrs: Record<string, unknown>;
  /** Nested child blocks, in document order. */
  innerBlocks: BlockNode[];
  /** Concatenation of every literal-HTML chunk between the delimiters (excludes child markup). */
  innerHTML: string;
  /**
   * Ordered interleaving of literal HTML (`string`) and child-block placeholders
   * (`null`). Walking this array and substituting each `null` with the next
   * `innerBlocks` entry reconstructs the original inner markup verbatim — this is
   * what makes nested round-tripping exact.
   */
  innerContent: Array<string | null>;
}

/**
 * Block delimiter tokenizer.
 *
 * Capture groups:
 *   1  closing slash  -> present on `<!-- /wp:name -->`
 *   2  namespace+`/`  -> e.g. `acf/` (optional; absent for core blocks)
 *   3  block name     -> e.g. `paragraph`
 *   4  attributes     -> `{...}` JSON plus its trailing whitespace (optional)
 *   5  void slash     -> present on self-closing `<!-- wp:name /-->`
 *
 * The attribute sub-pattern lazily consumes any character (including `}` from
 * nested JSON objects) and only stops at the `}` that is immediately followed by
 * `\s+/?-->`, mirroring the upstream PEG so nested attribute objects parse correctly.
 */
const DELIMITER =
  /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+({(?:(?!}\s+\/?-->)[\s\S])*?}\s+)?(\/)?-->/g;

type TokenType = "no-more-tokens" | "void-block" | "block-opener" | "block-closer";

interface Token {
  type: TokenType;
  blockName: string | null;
  attrs: Record<string, unknown>;
  start: number;
  length: number;
}

interface Frame {
  block: BlockNode;
  tokenStart: number;
  tokenLength: number;
  prevOffset: number;
  leadingHtmlStart: number | null;
}

function makeBlock(
  blockName: string | null,
  attrs: Record<string, unknown>,
  innerBlocks: BlockNode[],
  innerHTML: string,
  innerContent: Array<string | null>,
): BlockNode {
  return { blockName, attrs, innerBlocks, innerHTML, innerContent };
}

function makeFreeform(innerHTML: string): BlockNode {
  return makeBlock(null, {}, [], innerHTML, [innerHTML]);
}

/**
 * Parse Gutenberg block markup into a tree of {@link BlockNode}s.
 *
 * @param content - Raw `post_content` (the `content.raw` field from a REST `context=edit` fetch).
 * @returns Top-level blocks in document order. Freeform/classic HTML and
 *          inter-block whitespace are returned as nodes with `blockName === null`.
 */
export function parseBlocks(content: string): BlockNode[] {
  const document = typeof content === "string" ? content : "";
  const output: BlockNode[] = [];
  const stack: Frame[] = [];
  let offset = 0;
  DELIMITER.lastIndex = 0;

  const nextToken = (): Token => {
    const match = DELIMITER.exec(document);
    if (!match) {
      return { type: "no-more-tokens", blockName: null, attrs: {}, start: 0, length: 0 };
    }
    const [all, closerSlash, namespace, name, attrsRaw, voidSlash] = match;
    const start = match.index;
    const length = all.length;
    const blockName = `${namespace || "core/"}${name}`;
    let attrs: Record<string, unknown> = {};
    if (attrsRaw) {
      try {
        const parsed = JSON.parse(attrsRaw.trim());
        if (parsed && typeof parsed === "object") {
          attrs = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed attribute JSON: keep {} rather than throwing — be lenient on read.
        attrs = {};
      }
    }
    if (closerSlash) {
      return { type: "block-closer", blockName, attrs: {}, start, length };
    }
    if (voidSlash) {
      return { type: "void-block", blockName, attrs, start, length };
    }
    return { type: "block-opener", blockName, attrs, start, length };
  };

  const addFreeform = (rawLength?: number): void => {
    const length = rawLength ?? document.length - offset;
    if (length <= 0) return;
    output.push(makeFreeform(document.substr(offset, length)));
  };

  const addInnerBlock = (block: BlockNode, tokenStart: number, tokenLength: number, lastOffset?: number): void => {
    const parent = stack[stack.length - 1];
    parent.block.innerBlocks.push(block);
    const html = document.substr(parent.prevOffset, tokenStart - parent.prevOffset);
    if (html) {
      parent.block.innerHTML += html;
      parent.block.innerContent.push(html);
    }
    parent.block.innerContent.push(null);
    parent.prevOffset = lastOffset ?? tokenStart + tokenLength;
  };

  const addBlockFromStack = (endOffset?: number): void => {
    const { block, leadingHtmlStart, prevOffset, tokenStart } = stack[stack.length - 1];
    const html =
      endOffset !== undefined ? document.substr(prevOffset, endOffset - prevOffset) : document.substr(prevOffset);
    if (html) {
      block.innerHTML += html;
      block.innerContent.push(html);
    }
    if (leadingHtmlStart !== null) {
      output.push(makeFreeform(document.substr(leadingHtmlStart, tokenStart - leadingHtmlStart)));
    }
    stack.pop();
    output.push(block);
  };

  const proceed = (): boolean => {
    const stackDepth = stack.length;
    const token = nextToken();
    const { type, blockName, attrs, start, length } = token;
    const leadingHtmlStart = start > offset ? offset : null;

    switch (type) {
      case "no-more-tokens":
        if (stackDepth === 0) {
          addFreeform();
          return false;
        }
        // Unclosed blocks: flush them, preserving any trailing leading HTML.
        while (stack.length > 0) {
          addBlockFromStack();
        }
        return false;

      case "void-block":
        if (stackDepth === 0) {
          if (leadingHtmlStart !== null) addFreeform(start - leadingHtmlStart);
          output.push(makeBlock(blockName, attrs, [], "", []));
          offset = start + length;
          return true;
        }
        addInnerBlock(makeBlock(blockName, attrs, [], "", []), start, length);
        offset = start + length;
        return true;

      case "block-opener":
        stack.push({
          block: makeBlock(blockName, attrs, [], "", []),
          tokenStart: start,
          tokenLength: length,
          prevOffset: start + length,
          leadingHtmlStart,
        });
        offset = start + length;
        return true;

      case "block-closer":
        if (stackDepth === 0) {
          // Stray closer with no matching opener: treat preceding text as freeform.
          if (leadingHtmlStart !== null) addFreeform(start - leadingHtmlStart);
          offset = start + length;
          return true;
        }
        if (stackDepth === 1) {
          addBlockFromStack(start);
          offset = start + length;
          return true;
        }
        // Nested close: fold the popped block into its parent's inner content.
        {
          const stackTop = stack.pop() as Frame;
          const html = document.substr(stackTop.prevOffset, start - stackTop.prevOffset);
          stackTop.block.innerHTML += html;
          if (html) stackTop.block.innerContent.push(html);
          addInnerBlock(stackTop.block, stackTop.tokenStart, stackTop.tokenLength, start + length);
          offset = start + length;
          return true;
        }
    }
  };

  if (document.length > 0) {
    while (proceed()) {
      /* iterate until the document is consumed */
    }
  }

  return output;
}

/** Drop the canonical `core/` namespace for delimiter output (WordPress omits it). */
function delimiterName(blockName: string): string {
  return blockName.startsWith("core/") ? blockName.slice("core/".length) : blockName;
}

function serializeAttrs(attrs: Record<string, unknown> | null | undefined): string {
  if (!attrs || Object.keys(attrs).length === 0) return "";
  // Match WordPress's serializeAttributes() exactly: compact JSON with HTML-comment-
  // and tag-sensitive characters escaped, so re-serialized content is byte-identical
  // to what WordPress originally wrote (and JSON.parse reverses the \uXXXX escapes).
  const json = JSON.stringify(attrs)
    .replace(/--/g, "\\u002d\\u002d")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\\"/g, "\\u0022");
  return ` ${json}`;
}

/**
 * Serialize one block to its delimiter-wrapped markup.
 * Freeform nodes (`blockName === null`) emit their literal HTML unwrapped.
 */
export function serializeBlock(block: BlockNode): string {
  if (block.blockName === null) {
    // Freeform / classic HTML / inter-block whitespace.
    return block.innerContent.map((chunk) => (typeof chunk === "string" ? chunk : "")).join("");
  }

  const name = delimiterName(block.blockName);
  const attrs = serializeAttrs(block.attrs);

  // A void/self-closing block has no inner content at all.
  if (block.innerContent.length === 0) {
    return `<!-- wp:${name}${attrs} /-->`;
  }

  let childIndex = 0;
  const inner = block.innerContent
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const child = block.innerBlocks[childIndex++];
      return child ? serializeBlock(child) : "";
    })
    .join("");

  return `<!-- wp:${name}${attrs} -->${inner}<!-- /wp:${name} -->`;
}

/**
 * Serialize a tree of blocks back to `post_content` markup.
 *
 * @param blocks - Tree produced by {@link parseBlocks} (or hand-built).
 * @returns Markup suitable for the `content` field of a posts/pages/blocks REST write.
 */
export function serializeBlocks(blocks: BlockNode[]): string {
  if (!Array.isArray(blocks)) return "";
  return blocks.map(serializeBlock).join("");
}

/**
 * Convenience: flatten a block tree depth-first into a single list.
 * Useful for "find every core/image" style scans without writing recursion at the call site.
 */
export function flattenBlocks(blocks: BlockNode[]): BlockNode[] {
  const out: BlockNode[] = [];
  const walk = (list: BlockNode[]): void => {
    for (const b of list) {
      out.push(b);
      if (b.innerBlocks.length) walk(b.innerBlocks);
    }
  };
  walk(blocks);
  return out;
}
