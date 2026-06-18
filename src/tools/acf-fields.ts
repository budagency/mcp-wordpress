/**
 * WordPress ACF-Field Editing Tools (Bud Agency expansion, gap #6 / spike B2)
 *
 * For pages/posts whose content lives in PAGE-LEVEL ACF fields exposed through the
 * REST `acf` property (field group has "Show in REST API" enabled) — e.g. APWA,
 * which builds every page from a single ACF **Flexible Content** field `layout`
 * (section rows → `blocks` sub-rows → `text_editor` etc.). Different mechanism from
 * acf-blocks.ts (B1, inline in post_content): here the data is the structured `acf`
 * REST object, edited by addressing a leaf via a dot-path (e.g.
 * `layout.0.blocks.0.text_editor`).
 *
 * Safety model (live client sites — dual-reviewed Codex + GLM):
 *   1. Path hardening — own-property navigation only (never the prototype chain);
 *      `__proto__`/`constructor`/`prototype` and the `acf_fc_layout` structural
 *      marker are rejected at ANY depth; array segments must be canonical indices
 *      (blocks `length`/`map`/… writes); no empty/malformed segments.
 *   2. Scalar-only edits — the target must be an existing scalar leaf, and the new
 *      value must be a JSON scalar (no replacing a leaf with a container).
 *   3. Minimal blast radius — only the ONE edited top-level ACF field is written
 *      (rebuilt from a FRESH read), never the whole `acf` object.
 *   4. "" → null coercion within that field (ACF returns "" for empty image/
 *      relational fields but rejects "" on write).
 *   5. Concurrency check (compare `modified`) + read-back verification that the leaf
 *      landed AND no sibling field changed (empties may normalise ""↔null — allowed;
 *      additions/removals/other changes are rejected).
 *
 * Residual: without a server-side compare-and-swap there is still a small race
 * between the pre-write read and the PUT — documented; the read-back is the canary.
 *
 * Tools:
 *   wp_get_acf_fields  — read a page/post's `acf` object as editable dot-path leaves
 *   wp_edit_acf_field  — set one scalar leaf by dot-path via the `acf` REST property
 */

import { WordPressClient } from "@/client/api.js";
import type { MCPToolSchema } from "@/types/mcp.js";
import { getErrorMessage } from "@/utils/error.js";

type PostType = "page" | "post";
type Acf = Record<string, unknown>;
type JsonLeaf = string | number | boolean | null;

interface EditableObj {
  acf: Acf;
  modified: string | null;
}

const MAX_VALUE_BYTES = 2_000_000;
const MAX_LISTED_LEAVES = 250;

/** Object keys that must never appear in a path — prototype-pollution vectors. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
/** ACF structural markers — not editable content (changing them breaks block structure). */
const STRUCTURAL_KEYS = new Set(["acf_fc_layout"]);

// ---------------------------------------------------------------------------
// Path helpers (own-property only; array indices only; no prototype traversal)
// ---------------------------------------------------------------------------

function isCanonicalIndex(s: string): boolean {
  return /^(0|[1-9]\d*)$/.test(s) && Number(s) <= Number.MAX_SAFE_INTEGER;
}

/**
 * Split + validate a dot-path. Rejects empty/malformed segments, prototype-pollution
 * segments, and the acf_fc_layout structural marker (at any depth).
 */
function splitPathStrict(path: unknown): string[] {
  if (typeof path !== "string") throw new Error('"path" must be a string.');
  if (path.length === 0) throw new Error('"path" is empty.');
  if (path.length > 4096) throw new Error('"path" is too long.');
  if (path.startsWith(".") || path.endsWith(".") || path.includes("..")) {
    throw new Error(`"path" has an empty segment: ${JSON.stringify(path)}.`);
  }
  const segs = path.split(".");
  if (segs.length > 64) throw new Error('"path" has too many segments (max 64).');
  for (const s of segs) {
    if (s.length === 0) throw new Error(`"path" has an empty segment: ${JSON.stringify(path)}.`);
    if (FORBIDDEN_SEGMENTS.has(s)) throw new Error(`Refusing unsafe path segment "${s}".`);
    if (STRUCTURAL_KEYS.has(s)) {
      throw new Error(`Refusing path segment "${s}": ACF structural marker, not editable content.`);
    }
  }
  return segs;
}

/** Resolve a path using OWN properties only; arrays accept canonical indices only. */
function getOwnPath(root: unknown, segs: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = root;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object") return { found: false };
    if (Array.isArray(cur)) {
      if (!isCanonicalIndex(s)) return { found: false };
      const i = Number(s);
      if (i >= cur.length || !Object.prototype.hasOwnProperty.call(cur, i)) return { found: false };
      cur = cur[i];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, s)) return { found: false };
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return { found: true, value: cur };
}

/** Set a value at a path whose parent chain already exists (own-only, indices-only). */
function setOwnPath(root: Acf, segs: string[], value: unknown): void {
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur === null || typeof cur !== "object") throw new Error(`Path segment "${s}" is not a container.`);
    if (Array.isArray(cur)) {
      const idx = Number(s);
      if (!isCanonicalIndex(s) || idx >= cur.length || !Object.prototype.hasOwnProperty.call(cur, idx)) {
        throw new Error(`Array index "${s}" not found.`);
      }
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, s)) throw new Error(`Path segment "${s}" not found.`);
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  const leaf = segs[segs.length - 1];
  if (cur === null || typeof cur !== "object") throw new Error(`Parent of "${leaf}" is not a container.`);
  if (Array.isArray(cur)) {
    const idx = Number(leaf);
    if (!isCanonicalIndex(leaf) || idx >= cur.length || !Object.prototype.hasOwnProperty.call(cur, idx)) {
      throw new Error(`Array index "${leaf}" not found.`);
    }
    cur[idx] = value;
  } else {
    if (!Object.prototype.hasOwnProperty.call(cur, leaf)) throw new Error(`Field "${leaf}" not found.`);
    (cur as Record<string, unknown>)[leaf] = value;
  }
}

/** Deep clone with "" → null coercion (ACF write contract), skipping unsafe keys. */
function cloneCoerce(v: unknown): unknown {
  if (v === "") return null;
  if (Array.isArray(v)) return v.map(cloneCoerce);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      // Fail closed (never silently drop) if the source data carries an unsafe key.
      if (FORBIDDEN_SEGMENTS.has(k)) throw new Error(`Refusing to write: ACF data contains an unsafe key "${k}".`);
      o[k] = cloneCoerce((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

/** Collect scalar leaves as path -> value. Skips empty ("" / null) unless includeEmpty. */
function collectLeaves(v: unknown, prefix: string, out: Record<string, unknown>, includeEmpty: boolean): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectLeaves(x, prefix ? `${prefix}.${i}` : String(i), out, includeEmpty));
  } else if (v && typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      collectLeaves((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out, includeEmpty);
    }
  } else {
    const empty = v === "" || v === null;
    if (includeEmpty || !empty) out[prefix] = v;
  }
}

const isEmptyish = (v: unknown): boolean => v === "" || v === null;

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

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parsePostType(params: Record<string, unknown>): PostType {
  const t = params.post_type;
  if (t === undefined || t === "page") return "page";
  if (t === "post") return "post";
  throw new Error('"post_type" must be "page" or "post".');
}

function parsePositiveInt(value: unknown, name: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer.`);
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new Error(`"${name}" must be a positive integer.`);
}

function endpointBase(type: PostType): string {
  return type === "post" ? "posts" : "pages";
}

async function readEditable(client: WordPressClient, type: PostType, id: number): Promise<EditableObj> {
  const obj = (await client.get(`${endpointBase(type)}/${id}?context=edit`)) as Record<string, unknown>;
  const acf = obj?.acf;
  if (!acf || typeof acf !== "object" || Array.isArray(acf)) {
    throw new Error(
      `No ACF fields are exposed for ${type} ${id}. The field group needs "Show in REST API" enabled ` +
        `(ACF → Field Groups → Group Settings), or this ${type} has no ACF fields.`,
    );
  }
  const modified = typeof obj.modified === "string" ? obj.modified : null;
  return { acf: acf as Acf, modified };
}

// ---------------------------------------------------------------------------
// ACFFieldTools
// ---------------------------------------------------------------------------

export class ACFFieldTools {
  public getTools(): Array<{
    name: string;
    description: string;
    inputSchema: MCPToolSchema;
    handler: (client: WordPressClient, params: Record<string, unknown>) => Promise<unknown>;
  }> {
    return [
      {
        name: "wp_get_acf_fields",
        description:
          "Reads a page/post's ACF fields from the REST `acf` property and lists them as editable dot-path leaves " +
          "(e.g. `layout.0.blocks.0.text_editor`). For sites whose content lives in page-level ACF fields / Flexible " +
          "Content (e.g. APWA) rather than inline ACF blocks. Requires the field group's 'Show in REST API' to be on. " +
          "Use BEFORE wp_edit_acf_field to discover the exact path to edit.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The page/post ID to inspect." },
            post_type: { type: "string", enum: ["page", "post"], description: '"page" (default) or "post".' },
            path: {
              type: "string",
              description: "Optional dot-path prefix to limit output to a subtree, e.g. `layout.0`.",
            },
            include_empty: {
              type: "boolean",
              description: "Include empty ('' / null) fields too. Default false (only fields with content).",
            },
          },
          required: ["id"],
        },
        handler: this.handleGetAcfFields.bind(this),
      },
      {
        name: "wp_edit_acf_field",
        description:
          "Sets ONE ACF field on a page/post by dot-path, via the REST `acf` property. Writes only the single " +
          "top-level ACF field that contains the target leaf (rebuilt from a fresh read), preserving everything else. " +
          "Use for page-level ACF / Flexible Content sites (e.g. APWA).\n\n" +
          "Safety: the path must resolve to an existing scalar leaf and the new value must be a scalar (no container " +
          "replacement); rejects unsafe path segments and array-method writes; aborts if the page changed since it was " +
          "read; verifies after writing that the leaf landed and no sibling field changed; supports dry_run. Discover " +
          "paths first with wp_get_acf_fields.\n\n" +
          "**Examples:**\n" +
          '• wp_edit_acf_field --id=2291 --path="layout.0.blocks.0.text_editor" --value="<h1>New heading</h1>"\n' +
          '• Number: --path="layout.2.columns" --value_json="3"\n' +
          "• Preview only: add --dry_run=true",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The page/post ID to edit." },
            post_type: { type: "string", enum: ["page", "post"], description: '"page" (default) or "post".' },
            path: { type: "string", description: "Dot-path to the field, e.g. `layout.0.blocks.0.text_editor`." },
            value: { type: "string", description: "New value as a string. For numbers/booleans use value_json." },
            value_json: {
              type: "string",
              description:
                "New value as a JSON scalar literal (e.g. '3', 'true', 'null'). Mutually exclusive with value.",
            },
            dry_run: {
              type: "boolean",
              description: "If true, return the before/after without writing. Default false.",
            },
          },
          required: ["id", "path"],
        },
        handler: this.handleEditAcfField.bind(this),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // wp_get_acf_fields
  // -------------------------------------------------------------------------

  public async handleGetAcfFields(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const id = parsePositiveInt(params.id, "id");
      const type = parsePostType(params);
      const includeEmpty = params.include_empty === true;
      const filterSegs = params.path !== undefined ? this.splitFilter(params.path) : null;

      const { acf } = await readEditable(client, type, id);

      let subtree: unknown = acf;
      if (filterSegs) {
        const r = getOwnPath(acf, filterSegs);
        if (!r.found) throw new Error(`Path "${String(params.path)}" not found on ${type} ${id}.`);
        subtree = r.value;
      }

      const leaves: Record<string, unknown> = Object.create(null);
      collectLeaves(subtree, filterSegs ? filterSegs.join(".") : "", leaves, includeEmpty);
      // Hide ACF structural markers — not editable content.
      const entries = Object.entries(leaves).filter(([p]) => !STRUCTURAL_KEYS.has(p.split(".").pop() as string));
      if (!entries.length) {
        return `No ${includeEmpty ? "" : "non-empty "}ACF field leaves found on ${type} ${id}${filterSegs ? ` under "${filterSegs.join(".")}"` : ""}.`;
      }

      const shown = entries.slice(0, MAX_LISTED_LEAVES);
      const lines = [
        `🧩 **ACF fields on ${type} ${id}** (${entries.length} editable leaf${entries.length === 1 ? "" : "es"}${includeEmpty ? "" : ", non-empty"})\n`,
      ];
      for (const [path, val] of shown) lines.push(`- \`${path}\` = ${preview(val)}`);
      if (entries.length > shown.length)
        lines.push(`\n…(+${entries.length - shown.length} more — narrow with the \`path\` prefix)`);
      lines.push(
        `\nEdit: \`wp_edit_acf_field --id=${id}${type === "post" ? " --post_type=post" : ""} --path="<path>" --value="<new value>"\``,
      );
      return lines.join("\n");
    } catch (error) {
      throw this.wrap("wp_get_acf_fields", error);
    }
  }

  // -------------------------------------------------------------------------
  // wp_edit_acf_field
  // -------------------------------------------------------------------------

  public async handleEditAcfField(client: WordPressClient, params: Record<string, unknown>): Promise<string> {
    try {
      const id = parsePositiveInt(params.id, "id");
      const type = parsePostType(params);
      const segs = splitPathStrict(params.path);
      const canonicalPath = segs.join(".");
      const newValue = this.resolveNewValue(params);
      this.assertScalar(newValue);
      this.assertValueSize(newValue, canonicalPath);
      const dryRun = this.parseBool(params.dry_run, "dry_run");

      // Read #1 — validate the target exists and is a scalar.
      const first = await readEditable(client, type, id);
      const target = getOwnPath(first.acf, segs);
      if (!target.found) {
        throw new Error(`Path "${canonicalPath}" not found on ${type} ${id}. Run wp_get_acf_fields for valid paths.`);
      }
      if (target.value !== null && typeof target.value === "object") {
        throw new Error(
          `Path "${canonicalPath}" points to a ${Array.isArray(target.value) ? "list" : "group"}, not an editable value.`,
        );
      }
      const oldValue = target.value;
      if (jsonEqual(oldValue, newValue)) {
        return `ℹ️ No change made: "${canonicalPath}" on ${type} ${id} already equals the requested value (${preview(newValue)}).`;
      }

      if (dryRun) {
        return `🔎 **Dry run — nothing written** (${type} ${id})\nPath: ${canonicalPath}\nOld: ${preview(oldValue)}\nNew: ${preview(newValue)}`;
      }

      // Read #2 (fresh) — concurrency check + rebuild the payload from the LATEST state.
      const latest = await readEditable(client, type, id);
      if (first.modified !== null && latest.modified !== null && first.modified !== latest.modified) {
        throw new Error(
          `Aborting: ${type} ${id} changed after it was read (concurrent edit). Nothing written. Re-run wp_get_acf_fields and retry.`,
        );
      }
      const latestTarget = getOwnPath(latest.acf, segs);
      if (!latestTarget.found || (latestTarget.value !== null && typeof latestTarget.value === "object")) {
        throw new Error(
          `Aborting: "${canonicalPath}" is no longer an editable leaf on ${type} ${id} (structure changed).`,
        );
      }

      // Build a MINIMAL payload: only the one top-level field, coerced, with the leaf set.
      const topKey = segs[0];
      const beforeTop = (getOwnPath(latest.acf, [topKey]) as { value: unknown }).value;
      let writtenTop: unknown;
      if (segs.length === 1) {
        writtenTop = newValue; // editing a top-level scalar field
      } else {
        const topPayload = cloneCoerce(beforeTop);
        if (topPayload === null || typeof topPayload !== "object") {
          throw new Error(`Top-level field "${topKey}" is not a container.`);
        }
        setOwnPath(topPayload as Acf, segs.slice(1), newValue);
        writtenTop = topPayload;
      }

      await client.put(`${endpointBase(type)}/${id}`, { acf: { [topKey]: writtenTop } });

      // Read-back verification against the fresh (latest) snapshot.
      await this.verifyPersisted(client, type, id, segs, canonicalPath, newValue, beforeTop, latest.acf);

      return (
        `✅ Updated "${canonicalPath}" on ${type} ${id}.\nOld: ${preview(oldValue)}\nNew: ${preview(newValue)}\n` +
        `(WordPress retains the previous revision for rollback.)`
      );
    } catch (error) {
      throw this.wrap("wp_edit_acf_field", error);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Verify the edited leaf landed and the rest of the top-level field is intact. */
  private async verifyPersisted(
    client: WordPressClient,
    type: PostType,
    id: number,
    segs: string[],
    canonicalPath: string,
    newValue: unknown,
    beforeTop: unknown,
    beforeAcf: Acf,
  ): Promise<void> {
    const after = (await readEditable(client, type, id)).acf;

    const landed = getOwnPath(after, segs);
    if (!landed.found || !jsonEqual(landed.value, newValue)) {
      throw new Error(
        `Post-write verification FAILED for ${type} ${id}: "${canonicalPath}" did not persist as sent ` +
          `(ACF/KSES/a save hook may have altered it). Manual review required.`,
      );
    }

    const topKey = segs[0];

    // Guard against ACF REST "replace" semantics silently wiping OTHER top-level fields.
    for (const k of Object.keys(beforeAcf)) {
      if (k === topKey) continue;
      if (!Object.prototype.hasOwnProperty.call(after, k)) {
        throw this.verifyFail(
          type,
          id,
          `another top-level ACF field "${k}" disappeared (ACF may be replacing, not merging)`,
        );
      }
    }

    const afterTop = (getOwnPath(after, [topKey]) as { found: boolean; value?: unknown }).value;
    const relTarget = segs.slice(1).join("."); // "" when editing a top-level scalar

    // Null-prototype accumulators: `in` checks stay own-only and a leaf path literally
    // named "__proto__" cannot trigger a setter on the accumulator.
    const b: Record<string, unknown> = Object.create(null);
    const a: Record<string, unknown> = Object.create(null);
    collectLeaves(beforeTop, "", b, true);
    collectLeaves(afterTop, "", a, true);

    for (const [p, v] of Object.entries(b)) {
      if (p === relTarget) continue;
      if (!(p in a)) throw this.verifyFail(type, id, `field "${topKey}${p ? "." + p : ""}" disappeared`);
      if (isEmptyish(v) && isEmptyish(a[p])) continue; // benign ""↔null normalisation
      if (!jsonEqual(a[p], v))
        throw this.verifyFail(type, id, `unrelated field "${topKey}${p ? "." + p : ""}" changed`);
    }
    for (const p of Object.keys(a)) {
      if (p === relTarget || p in b) continue;
      if (isEmptyish(a[p])) continue; // a newly-surfaced empty is harmless
      throw this.verifyFail(type, id, `unexpected new field "${topKey}${p ? "." + p : ""}" appeared`);
    }
  }

  private verifyFail(type: PostType, id: number, what: string): Error {
    return new Error(
      `Post-write verification FAILED for ${type} ${id}: ${what} during the edit. Manual review required.`,
    );
  }

  /** Path parse for the read-only get filter — blocks prototype segments, allows structural keys. */
  private splitFilter(path: unknown): string[] {
    if (typeof path !== "string" || path.length === 0) throw new Error('"path" must be a non-empty string.');
    const segs = path.split(".").filter((s) => s.length > 0);
    for (const s of segs) if (FORBIDDEN_SEGMENTS.has(s)) throw new Error(`Refusing unsafe path segment "${s}".`);
    return segs;
  }

  private resolveNewValue(params: Record<string, unknown>): unknown {
    const hasValue = params.value !== undefined;
    const hasJson = params.value_json !== undefined;
    if (hasValue && hasJson) throw new Error("Provide only one of value or value_json, not both.");
    if (!hasValue && !hasJson) throw new Error("One of value (string) or value_json (JSON scalar) is required.");
    if (hasValue) {
      if (typeof params.value !== "string") {
        throw new Error(`"value" must be a string (got ${typeof params.value}). For non-strings use value_json.`);
      }
      return params.value;
    }
    if (typeof params.value_json !== "string")
      throw new Error('"value_json" must be a string containing a JSON scalar.');
    try {
      return JSON.parse(params.value_json);
    } catch (err) {
      throw new Error(`value_json is not valid JSON: ${getErrorMessage(err)}`);
    }
  }

  private assertScalar(v: unknown): asserts v is JsonLeaf {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    throw new Error(
      "The new value must be a finite JSON scalar (string, number, boolean, or null) — not an object/array/NaN/Infinity.",
    );
  }

  private assertValueSize(value: unknown, path: string): void {
    const bytes =
      typeof value === "string"
        ? Buffer.byteLength(value, "utf8")
        : Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    if (bytes > MAX_VALUE_BYTES) {
      throw new Error(`Refusing to set "${path}": value is ${bytes} bytes (max ${MAX_VALUE_BYTES}). Likely a mistake.`);
    }
  }

  private parseBool(value: unknown, name: string): boolean {
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw new Error(`"${name}" must be a boolean.`);
    return value;
  }

  private wrap(tool: string, error: unknown): Error {
    const msg = getErrorMessage(error);
    return error instanceof Error
      ? new Error(`${tool} failed: ${msg}`, { cause: error })
      : new Error(`${tool} failed: ${msg}`);
  }
}

export default ACFFieldTools;
