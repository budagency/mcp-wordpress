/**
 * WordPress ACF-Block Editing Tools (Bud Agency expansion, gap #6 / spike B1)
 *
 * Many Bud-managed sites (PDL, GXR, Bud) build their pages from **ACF Blocks** —
 * Gutenberg blocks registered by Advanced Custom Fields whose field values are
 * stored INLINE in the block delimiter as JSON, e.g.
 *
 *   <!-- wp:acf/hero {"name":"acf/hero","data":{"title":"Family Law",
 *        "_title":"field_609378bd5d264"},"mode":"preview"} /-->
 *
 * The editable content is `attrs.data.<field>`; the sibling `_<field>` entry is
 * ACF's pointer to the field-group key and must NOT be touched. Because the data
 * lives in post_content, this needs no per-site `show_in_rest` toggle and no
 * page-builder API — we parse content.raw, mutate the one value, and PUT it back.
 *
 * Safety model (these run against live client production sites — corrupting a
 * page is the worst outcome, so every write is defended in depth):
 *   1. Pre-edit byte-stability gate — re-serialize the UNMUTATED parse and require
 *      it to equal content.raw exactly. If the markup doesn't round-trip we ABORT
 *      rather than risk rewriting the page.
 *   2. Post-edit LOCALIZATION gate — re-parse the edited content, confirm the new
 *      value landed, then revert just that field and require the result to equal
 *      the original raw byte-for-byte. This proves the write differs from the
 *      original by EXACTLY the intended value — no comment-delimiter injection, no
 *      collateral change, no structural corruption. Runs for dry_run too.
 *   3. Concurrency check — re-read immediately before writing and abort if the
 *      page changed since we read it (lost-update protection).
 *   4. Read-back verification — after writing, confirm the field actually persisted
 *      (KSES / save filters / permissions can silently alter content).
 *   5. Loud failure — unknown/ambiguous block, missing field, non-ACF block name,
 *      or non-ACF field (no `_field` key pointer) all error with what IS available.
 *
 * Tools:
 *   wp_get_acf_blocks  — enumerate a page/post's acf/* blocks + editable fields
 *   wp_edit_acf_block  — set one field on a selected acf block, byte-stable
 */

import { WordPressClient } from "@/client/api.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { getErrorMessage } from "@/utils/error.js";
import { parseBlocks, serializeBlocks, flattenBlocks, type BlockNode } from "@/utils/blocks.js";

// ---------------------------------------------------------------------------
// Types & small helpers
// ---------------------------------------------------------------------------

type PostType = "page" | "post";

interface EditableObject {
  raw: string;
  modified: string | null;
}

interface LocatedAcfBlock {
  node: BlockNode;
  blockName: string; // e.g. "acf/hero"
  occurrence: number; // 0-based index among blocks sharing blockName
}

/** Property names we must never write — prototype-pollution / shadowing vectors. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Hard cap on a single field value, to catch obviously-wrong payloads. */
const MAX_VALUE_BYTES = 2_000_000;

/** Pull the ACF field-data object from a block's attrs, or null if absent. */
function getAcfData(node: BlockNode): Record<string, unknown> | null {
  const data = (node.attrs as Record<string, unknown>)?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return null;
}

/** Collect every acf/* block in document order, numbering each by per-name occurrence. */
function collectAcfBlocks(tree: BlockNode[]): LocatedAcfBlock[] {
  const counts: Record<string, number> = {};
  const out: LocatedAcfBlock[] = [];
  for (const node of flattenBlocks(tree)) {
    if (typeof node.blockName === "string" && node.blockName.startsWith("acf/")) {
      const n = counts[node.blockName] ?? 0;
      counts[node.blockName] = n + 1;
      out.push({ node, blockName: node.blockName, occurrence: n });
    }
  }
  return out;
}

/** Does `field` look like a genuine ACF field (own, non-underscore, with a `_field` key pointer)? */
function isEditableAcfField(data: Record<string, unknown>, field: string): boolean {
  if (field.startsWith("_") || DANGEROUS_KEYS.has(field)) return false;
  if (!Object.prototype.hasOwnProperty.call(data, field)) return false;
  const ptr = data[`_${field}`];
  return typeof ptr === "string" && ptr.startsWith("field_");
}

/** Editable field names of an ACF data object (own, non-underscore, with a key pointer). */
function editableFields(data: Record<string, unknown>): string[] {
  return Object.keys(data).filter((k) => isEditableAcfField(data, k));
}

/** One-line, whitespace-collapsed, length-capped preview of a field value. */
function preview(v: unknown, len = 140): string {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > len ? s.slice(0, len) + "…" : s;
}

/** Stable structural equality for JSON-shaped values (ACF data is always JSON). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Fetch the editable object (content.raw + modified) for a page/post via context=edit. */
async function fetchEditable(client: WordPressClient, type: PostType, id: number): Promise<EditableObject> {
  const obj = type === "post" ? await client.getPost(id, "edit") : await client.getPage(id, "edit");
  const raw = obj.content?.raw;
  if (typeof raw !== "string") {
    throw new Error(
      `Could not retrieve raw content for ${type} ${id} (expected content.raw to be a string, got ` +
        `${raw === null ? "null" : typeof raw}). The site may not support context=edit here, or the user ` +
        `lacks editor/admin privileges.`,
    );
  }
  const modified = typeof obj.modified === "string" ? obj.modified : null;
  return { raw, modified };
}

/** PUT only the content field; return the updated object's raw content if the API echoes it. */
async function putContent(
  client: WordPressClient,
  type: PostType,
  id: number,
  content: string,
): Promise<string | null> {
  const res = type === "post" ? await client.updatePost({ id, content }) : await client.updatePage({ id, content });
  const echoed = (res as { content?: { raw?: unknown } } | undefined)?.content?.raw;
  return typeof echoed === "string" ? echoed : null;
}

function parsePostType(params: Record<string, unknown>): PostType {
  const t = params.post_type;
  if (t === undefined || t === "page") return "page";
  if (t === "post") return "post";
  throw new Error('"post_type" must be "page" or "post".');
}

/** Strict positive-integer parse (number, or a clean numeric string — no coercion surprises). */
function parsePositiveInt(value: unknown, name: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer.`);
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error(`"${name}" is out of the safe integer range.`);
    return n;
  }
  throw new Error(`"${name}" must be a positive integer.`);
}

/** Strict non-negative-integer parse with a default when absent. */
function parseNonNegativeInt(value: unknown, name: string, dflt: number): number {
  if (value === undefined) return dflt;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`"${name}" must be a non-negative integer.`);
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
  throw new Error(`"${name}" must be a non-negative integer.`);
}

// ---------------------------------------------------------------------------
// ACFBlockTools
// ---------------------------------------------------------------------------

export class ACFBlockTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_get_acf_blocks",
        description:
          "Lists the ACF Blocks (acf/* Gutenberg blocks) on a page or post and their editable field values. " +
          "ACF Blocks store their field data inline in post_content, so this works on any site whose pages are " +
          "built with ACF blocks (e.g. PDL, GXR) without any show_in_rest toggle. Use this BEFORE wp_edit_acf_block " +
          "to discover block names, occurrences, and field names.\n\n" +
          "Returns, per block: the block name, its 0-based occurrence among same-named blocks, and each editable " +
          "field (an ACF field with a `_field` key pointer) with a value preview. ACF key pointers are hidden.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The page/post ID to inspect." },
            post_type: {
              type: "string",
              enum: ["page", "post"],
              description: 'Whether the ID is a "page" (default) or a "post".',
            },
            block_name: {
              type: "string",
              description: 'Optional filter, e.g. "acf/hero" — only blocks of this name are listed.',
            },
          },
          required: ["id"],
        },
        handler: this.handleGetAcfBlocks.bind(this),
      },
      {
        name: "wp_edit_acf_block",
        description:
          "Edits a single field of one ACF Block on a page/post, in place, preserving the rest of the page exactly. " +
          "Selects the block by name + occurrence, sets `field` to a new value, re-serializes the markup byte-for-byte " +
          "except the changed value, and PUTs only the content field.\n\n" +
          "Safety: aborts if the page can't be round-tripped byte-stably (no risky full-page rewrite); proves the edit " +
          "is localized to exactly the one value (injection-proof); requires `occurrence` when several blocks share a " +
          "name; aborts if the page changed since it was read; verifies the value persisted after writing; refuses ACF " +
          "`_field` pointers and non-ACF fields; supports dry_run. Discover names/fields first with wp_get_acf_blocks.\n\n" +
          "**Examples:**\n" +
          '• Scalar: wp_edit_acf_block --id=1828 --block_name="acf/hero" --field="title" --value="New Title"\n' +
          "• 2nd block of a type: add --occurrence=1\n" +
          '• Structured value: --field="logos" --value_json="[473,2250,2256]"\n' +
          "• Preview only: add --dry_run=true",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The page/post ID to edit." },
            post_type: {
              type: "string",
              enum: ["page", "post"],
              description: 'Whether the ID is a "page" (default) or a "post".',
            },
            block_name: {
              type: "string",
              description: 'The ACF block name, e.g. "acf/hero" (from wp_get_acf_blocks).',
            },
            occurrence: {
              type: "number",
              description:
                "0-based index among blocks sharing block_name. Required when more than one such block exists; " +
                "defaults to 0 only when the block name is unique on the page.",
            },
            field: {
              type: "string",
              description: "The ACF field name to set (an editable, non-underscore key from wp_get_acf_blocks).",
            },
            value: {
              type: "string",
              description: "New value as a string. For numbers/arrays/objects use value_json instead.",
            },
            value_json: {
              type: "string",
              description:
                "New value as a JSON literal (e.g. '123', 'true', '[1,2]', '{\"a\":1}'). " +
                "Mutually exclusive with value; exactly one of value/value_json is required.",
            },
            dry_run: {
              type: "boolean",
              description: "If true, validate and return the before/after without writing. Default false.",
            },
          },
          required: ["id", "block_name", "field"],
        },
        handler: this.handleEditAcfBlock.bind(this),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // wp_get_acf_blocks
  // -------------------------------------------------------------------------

  public async handleGetAcfBlocks(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const id = parsePositiveInt(params.id, "id");
      const type = parsePostType(params);
      const filter = typeof params.block_name === "string" ? params.block_name : undefined;

      const { raw } = await fetchEditable(client, type, id);
      const tree = parseBlocks(raw);
      let blocks = collectAcfBlocks(tree);
      if (filter) blocks = blocks.filter((b) => b.blockName === filter);

      if (!blocks.length) {
        return filter
          ? `No \`${filter}\` blocks found on ${type} ${id}.`
          : `No ACF blocks found on ${type} ${id}. ` +
              `(Content may be classic HTML, core Gutenberg blocks, or a page builder.)`;
      }

      const lines: string[] = [`🧩 **ACF blocks on ${type} ${id}** (${blocks.length})\n`];
      for (const b of blocks) {
        const data = getAcfData(b.node);
        lines.push(`### ${b.blockName}  (occurrence ${b.occurrence})`);
        const mode = (b.node.attrs as Record<string, unknown>).mode;
        if (typeof mode === "string") lines.push(`_mode: ${mode}_`);
        if (!data) {
          lines.push("(no field data)\n");
          continue;
        }
        const fields = editableFields(data);
        if (!fields.length) {
          lines.push("(no editable fields)\n");
          continue;
        }
        for (const f of fields) {
          const keyPtr = data[`_${f}`];
          const keyNote = typeof keyPtr === "string" ? `  _(key: ${keyPtr})_` : "";
          lines.push(`- **${f}**: ${preview(data[f])}${keyNote}`);
        }
        lines.push("");
      }
      lines.push(
        `\nTo edit: \`wp_edit_acf_block --id=${id}` +
          (type === "post" ? " --post_type=post" : "") +
          ` --block_name="<name>" --field="<field>" --value="<new value>"\``,
      );
      return lines.join("\n");
    } catch (error) {
      throw this.wrap("wp_get_acf_blocks", error);
    }
  }

  // -------------------------------------------------------------------------
  // wp_edit_acf_block
  // -------------------------------------------------------------------------

  public async handleEditAcfBlock(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const id = parsePositiveInt(params.id, "id");
      const type = parsePostType(params);

      const blockName = typeof params.block_name === "string" ? params.block_name : undefined;
      if (!blockName) throw new Error('"block_name" (string) is required, e.g. "acf/hero".');
      if (!blockName.startsWith("acf/")) {
        throw new Error(`"block_name" must be an ACF block (start with "acf/"), e.g. "acf/hero". Got "${blockName}".`);
      }

      const field = typeof params.field === "string" ? params.field : undefined;
      if (!field) throw new Error('"field" (string) is required.');
      if (field.startsWith("_") || DANGEROUS_KEYS.has(field)) {
        throw new Error(
          `Refusing to edit "${field}": underscore-prefixed keys are ACF field-key pointers and ` +
            `reserved names are not editable.`,
        );
      }

      const occurrenceProvided = params.occurrence !== undefined;
      const occurrence = parseNonNegativeInt(params.occurrence, "occurrence", 0);
      const dryRun = this.parseBool(params.dry_run, "dry_run", false);
      const newValue = this.resolveNewValue(params);
      this.assertValueSize(newValue, field);

      // Read.
      const { raw, modified } = await fetchEditable(client, type, id);
      const tree = parseBlocks(raw);

      // GATE 1 — pre-edit byte-stability.
      if (serializeBlocks(tree) !== raw) {
        throw new Error(
          `Aborting: ${type} ${id} content does not round-trip byte-for-byte through the block serializer, ` +
            `so an in-place edit could corrupt the page. This usually means non-canonical markup or a parser ` +
            `limitation. Use wp_edit_${type}_content (literal find/replace) for this page instead.`,
        );
      }

      // Locate the target block (require disambiguation when ambiguous).
      const acfBlocks = collectAcfBlocks(tree);
      const matches = acfBlocks.filter((b) => b.blockName === blockName);
      if (!matches.length) {
        throw new Error(
          `Block \`${blockName}\` not found on ${type} ${id}.\nAvailable ACF blocks:\n${this.summarize(acfBlocks)}`,
        );
      }
      if (matches.length > 1 && !occurrenceProvided) {
        throw new Error(
          `Ambiguous: found ${matches.length} \`${blockName}\` blocks on ${type} ${id}. ` +
            `Pass "occurrence" (0–${matches.length - 1}) to choose one.`,
        );
      }
      const target = matches.find((b) => b.occurrence === occurrence);
      if (!target) {
        throw new Error(
          `Block \`${blockName}\` occurrence ${occurrence} not found on ${type} ${id}. ` +
            `Valid occurrences: 0–${matches.length - 1}.`,
        );
      }

      const data = getAcfData(target.node);
      if (!data) throw new Error(`Block \`${blockName}\` (occurrence ${occurrence}) has no ACF field data.`);
      if (!isEditableAcfField(data, field)) {
        const fields = editableFields(data);
        const reason = Object.prototype.hasOwnProperty.call(data, field)
          ? `"${field}" is not an editable ACF field (no \`_${field}\` field-key pointer)`
          : `"${field}" not found`;
        throw new Error(
          `${reason} on \`${blockName}\` (occurrence ${occurrence}). Editable fields: ${fields.join(", ") || "(none)"}`,
        );
      }

      const oldValue = data[field];
      if (jsonEqual(oldValue, newValue)) {
        return (
          `ℹ️ No change made: \`${blockName}\` (occurrence ${occurrence}) field "${field}" ` +
          `already equals the requested value (${preview(newValue)}).`
        );
      }

      // Mutate + re-serialize.
      const beforeBlock = serializeBlocks([target.node]);
      data[field] = newValue;
      const afterBlock = serializeBlocks([target.node]);
      const newContent = serializeBlocks(tree);

      // GATE 2 — localization proof (injection-proof). Re-parse the edited content,
      // confirm the new value landed, revert just that field, and require byte-equality
      // with the original raw. Any collateral change / delimiter injection fails here.
      this.assertLocalizedEdit(newContent, raw, blockName, occurrence, field, newValue, oldValue);

      if (dryRun) {
        return (
          `🔎 **Dry run — validated, nothing written** (${type} ${id}, \`${blockName}\` occurrence ${occurrence})\n\n` +
          `Field: ${field}\nOld: ${preview(oldValue)}\nNew: ${preview(newValue)}\n\n` +
          `Block before:\n\`\`\`html\n${beforeBlock}\n\`\`\`\nBlock after:\n\`\`\`html\n${afterBlock}\n\`\`\``
        );
      }

      // GATE 3 — concurrency re-check: abort if the page changed since we read it.
      const current = await fetchEditable(client, type, id);
      if (current.raw !== raw || (modified !== null && current.modified !== null && current.modified !== modified)) {
        throw new Error(
          `Aborting: ${type} ${id} changed after it was read (a concurrent edit). Nothing written. ` +
            `Re-run wp_get_acf_blocks and retry against the latest content.`,
        );
      }

      // Write.
      const echoedRaw = await putContent(client, type, id, newContent);

      // GATE 4 — read-back verification: confirm the field actually persisted.
      await this.verifyPersisted(client, type, id, blockName, occurrence, field, newValue, echoedRaw);

      return (
        `✅ Updated \`${blockName}\` (occurrence ${occurrence}) on ${type} ${id}.\n` +
        `Field: ${field}\nOld: ${preview(oldValue)}\nNew: ${preview(newValue)}\n` +
        `(Previous revision retained by WordPress for rollback.)`
      );
    } catch (error) {
      throw this.wrap("wp_edit_acf_block", error);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** GATE 2 implementation — prove the edit is localized to exactly one field. */
  private assertLocalizedEdit(
    newContent: string,
    raw: string,
    blockName: string,
    occurrence: number,
    field: string,
    newValue: unknown,
    oldValue: unknown,
  ): void {
    const verifyTree = parseBlocks(newContent);
    if (serializeBlocks(verifyTree) !== newContent) {
      throw new Error(
        `Aborting: the edited content does not round-trip byte-for-byte (the new value for "${field}" may ` +
          `contain characters that destabilize block serialization). Nothing written.`,
      );
    }
    const reAcf = collectAcfBlocks(verifyTree);
    const reTarget = reAcf.find((b) => b.blockName === blockName && b.occurrence === occurrence);
    const reData = reTarget ? getAcfData(reTarget.node) : null;
    if (!reData || !jsonEqual(reData[field], newValue)) {
      throw new Error(`Aborting: the new value for "${field}" did not serialize as expected. Nothing written.`);
    }
    // Revert just this field; the document must now equal the original raw exactly.
    reData[field] = oldValue;
    if (serializeBlocks(verifyTree) !== raw) {
      throw new Error(
        `Aborting: the edit was not localized to "${field}" — reverting it does not reproduce the original ` +
          `page. This indicates collateral change or markup corruption. Nothing written.`,
      );
    }
  }

  /** GATE 4 implementation — confirm the field persisted on the server. */
  private async verifyPersisted(
    client: WordPressClient,
    type: PostType,
    id: number,
    blockName: string,
    occurrence: number,
    field: string,
    newValue: unknown,
    echoedRaw: string | null,
  ): Promise<void> {
    let savedRaw = echoedRaw;
    if (savedRaw === null) {
      try {
        savedRaw = (await fetchEditable(client, type, id)).raw;
      } catch {
        // Could not read back (e.g. context=edit blocked on this site). Don't fail the
        // write that already succeeded; the caller's success message stands.
        return;
      }
    }
    const saved = collectAcfBlocks(parseBlocks(savedRaw)).find(
      (b) => b.blockName === blockName && b.occurrence === occurrence,
    );
    const savedData = saved ? getAcfData(saved.node) : null;
    if (!savedData || !jsonEqual(savedData[field], newValue)) {
      throw new Error(
        `Post-write verification FAILED for ${type} ${id}: field "${field}" did not persist as sent ` +
          `(WordPress may have filtered the content via KSES or a save hook). Manual review required.`,
      );
    }
  }

  /** Resolve the new value from value/value_json (exactly one required, value must be a string). */
  private resolveNewValue(params: Record<string, unknown>): unknown {
    const hasValue = params.value !== undefined;
    const hasJson = params.value_json !== undefined;
    if (hasValue && hasJson) throw new Error("Provide only one of value or value_json, not both.");
    if (!hasValue && !hasJson) throw new Error("One of value (string) or value_json (JSON literal) is required.");
    if (hasValue) {
      if (typeof params.value !== "string") {
        throw new Error(`"value" must be a string (got ${typeof params.value}). For non-strings use value_json.`);
      }
      return params.value;
    }
    if (typeof params.value_json !== "string") {
      throw new Error('"value_json" must be a string containing a JSON literal.');
    }
    try {
      return JSON.parse(params.value_json);
    } catch (err) {
      throw new Error(`value_json is not valid JSON: ${getErrorMessage(err)}`);
    }
  }

  private assertValueSize(value: unknown, field: string): void {
    const bytes =
      typeof value === "string"
        ? Buffer.byteLength(value, "utf8")
        : Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    if (bytes > MAX_VALUE_BYTES) {
      throw new Error(
        `Refusing to set "${field}": value is ${bytes} bytes (max ${MAX_VALUE_BYTES}). Likely a mistake.`,
      );
    }
  }

  private parseBool(value: unknown, name: string, dflt: boolean): boolean {
    if (value === undefined) return dflt;
    if (typeof value !== "boolean") throw new Error(`"${name}" must be a boolean.`);
    return value;
  }

  private summarize(blocks: LocatedAcfBlock[]): string {
    if (!blocks.length) return "  (none — this page has no ACF blocks)";
    return blocks.map((b) => `  - ${b.blockName} (occurrence ${b.occurrence})`).join("\n");
  }

  /** Wrap an error with the tool name while preserving the original as the cause. */
  private wrap(tool: string, error: unknown): Error {
    const msg = getErrorMessage(error);
    return error instanceof Error
      ? new Error(`${tool} failed: ${msg}`, { cause: error })
      : new Error(`${tool} failed: ${msg}`);
  }
}

export default ACFBlockTools;
