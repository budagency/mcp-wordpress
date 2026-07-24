/**
 * Media Operations Module
 * Handles all media-related WordPress REST API operations
 */

import { promises as fsPromises } from "fs";
import * as path from "path";
import type { WordPressMedia, MediaQueryParams, UploadMediaRequest, UpdateMediaRequest } from "@/types/wordpress.js";
import type { RequestOptions } from "@/types/client.js";
import { LoggerFactory } from "@/utils/logger.js";

const log = LoggerFactory.client("MEDIA");

/**
 * Interface for the base client methods needed by media operations
 */
export interface MediaClientBase {
  get<T>(endpoint: string): Promise<T>;
  post<T>(endpoint: string, data?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(endpoint: string, data?: unknown): Promise<T>;
  delete<T>(endpoint: string): Promise<T>;
  /** Returns the site base URL (e.g. https://example.com) without trailing slash. */
  getSiteUrl(): string;
}

/**
 * Media operations mixin
 * Provides CRUD operations for WordPress media
 */
export class MediaOperations {
  constructor(private client: MediaClientBase) {}

  /**
   * Get a list of media items with optional filtering
   */
  async getMedia(params?: MediaQueryParams): Promise<WordPressMedia[]> {
    const normalizedParams = params
      ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
      : undefined;
    const queryString = normalizedParams ? "?" + new URLSearchParams(normalizedParams).toString() : "";
    return this.client.get<WordPressMedia[]>(`media${queryString}`);
  }

  /**
   * Get a single media item by ID
   */
  async getMediaItem(id: number, context: "view" | "embed" | "edit" = "view"): Promise<WordPressMedia> {
    return this.client.get<WordPressMedia>(`media/${id}?context=${context}`);
  }

  /**
   * Upload media from a file path
   */
  async uploadMedia(data: UploadMediaRequest): Promise<WordPressMedia> {
    // Use file handle to avoid TOCTOU race condition
    let fileHandle;
    try {
      fileHandle = await fsPromises.open(data.file_path, "r");
    } catch {
      throw new Error(`File not found: ${data.file_path}`);
    }

    try {
      const stats = await fileHandle.stat();
      // Always derive the upload filename from the file path, never from
      // `data.title` (Bud fix). A human-readable title commonly has no file
      // extension, so using it as the filename produced wrong extensions and
      // tripped WordPress's filetype check ("Sorry, you are not allowed to
      // upload this file type."). The title is still applied as media metadata
      // via the follow-up update below.
      const filename = path.basename(data.file_path);

      // Check if file is too large (WordPress default is 2MB for most installs)
      const maxSize = 10 * 1024 * 1024; // 10MB reasonable limit
      if (stats.size > maxSize) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB. Maximum allowed: ${maxSize / 1024 / 1024}MB`,
        );
      }

      const fileBuffer = await fileHandle.readFile();

      log.debug(`Uploading file: ${filename} (${(stats.size / 1024).toFixed(2)}KB)`);

      const mimeType = this.getMimeType(data.file_path);
      this.validateMagicBytes(fileBuffer, mimeType, data.file_path);

      return this.uploadFile(fileBuffer, filename, mimeType, data);
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Upload a file buffer as media
   */
  async uploadFile(
    fileData: Buffer,
    filename: string,
    mimeType: string,
    meta: Partial<UploadMediaRequest> = {},
    options?: RequestOptions,
  ): Promise<WordPressMedia> {
    log.debug(`Uploading file: ${filename} (${fileData.length} bytes)`);

    // Bud fix (carried from local dist patch — see project_wordpress_mcp memory):
    // Node's native fetch (undici) does not consume the `form-data` package's Node
    // stream, so the multipart body was dropped and the default application/json
    // Content-Type leaked through — WordPress rejected it as "Invalid JSON body
    // passed". Send the raw binary with a Content-Disposition header (the WP REST
    // media endpoint accepts this), then apply any metadata via a follow-up update.
    // (Upstream 3.3.x fixes the same root cause with native FormData+Blob; we keep
    // the raw-binary transport because our custom replaceMedia() reuses it against
    // the Bud Media Replace plugin route — see replaceMedia below.)
    const uploadTimeout = options?.timeout !== undefined ? options.timeout : 600000; // 10 minutes default
    // Non-idempotent create — single attempt to avoid duplicate attachments on
    // a post-processing network error (a Buffer body would otherwise be retried;
    // see api.ts isRetryableBody). retries:1 → configuredRetries=1 → maxAttempts=1.
    const created = await this.client.post<WordPressMedia>("media", fileData, {
      ...options,
      retries: 1,
      timeout: uploadTimeout,
      headers: {
        ...options?.headers,
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });

    const metaUpdate: Record<string, unknown> = {};
    if (meta.title) metaUpdate.title = meta.title;
    if (meta.alt_text) metaUpdate.alt_text = meta.alt_text;
    if (meta.caption) metaUpdate.caption = meta.caption;
    if (meta.description) metaUpdate.description = meta.description;
    if (meta.post) metaUpdate.post = meta.post;

    if (created && created.id && Object.keys(metaUpdate).length > 0) {
      return this.client.put<WordPressMedia>(`media/${created.id}`, metaUpdate);
    }
    return created;
  }

  /**
   * Update media metadata
   */
  async updateMedia(data: UpdateMediaRequest): Promise<WordPressMedia> {
    const { id, ...updateData } = data;
    return this.client.put<WordPressMedia>(`media/${id}`, updateData);
  }

  /**
   * Delete a media item
   */
  async deleteMedia(id: number, force = false): Promise<{ deleted: boolean; previous?: WordPressMedia }> {
    return this.client.delete(`media/${id}?force=${force}`);
  }

  /**
   * Replace the binary of an existing attachment in place.
   *
   * Sends the file bytes to the Bud Media Replace plugin route
   * (`POST /wp-json/bud/v1/media/<id>/replace`) using the same raw-binary
   * transport established in uploadFile. The attachment ID, original filename,
   * and all existing URLs are preserved — only the bytes on disk change.
   *
   * Magic-byte validation is applied before the network call to catch
   * disguised files early (mirrors uploadMedia behaviour).
   *
   * @param id       Attachment ID to replace.
   * @param fileData Raw file bytes.
   * @param filename Original or replacement filename (used in Content-Disposition).
   * @param mimeType MIME type of the new file (used in Content-Type + magic check).
   */
  async replaceMedia(id: number, fileData: Buffer, filename: string, mimeType: string): Promise<WordPressMedia> {
    this.validateMagicBytes(fileData, mimeType, filename);

    const siteUrl = this.client.getSiteUrl();
    // Build absolute URL — api.ts:request() detects the "http" prefix and uses it
    // verbatim instead of prepending the default /wp-json/wp/v2 base path.
    const absoluteUrl = `${siteUrl}/wp-json/bud/v1/media/${id}/replace`;

    log.debug(`Replacing media ${id} at ${absoluteUrl} (${fileData.length} bytes)`);

    return this.client.post<WordPressMedia>(absoluteUrl, fileData, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  /**
   * Validates that a file's magic bytes match its declared MIME type.
   * Prevents disguised uploads (e.g. a PHP script renamed to .jpg).
   */
  private validateMagicBytes(buffer: Buffer, mimeType: string, filePath: string): void {
    // Magic byte signatures for image types that could be dangerous if spoofed
    const signatures: Array<{ mime: string; bytes: number[]; offset?: number }> = [
      { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
      { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
      { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
      { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF header
      { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
    ];

    const sig = signatures.find((s) => s.mime === mimeType);
    if (!sig) return; // No magic bytes check for unrecognised types

    const offset = sig.offset ?? 0;
    const matches = sig.bytes.every((byte, i) => buffer[offset + i] === byte);
    if (!matches) {
      throw new Error(
        `File content does not match declared type ${mimeType} for: ${path.basename(filePath)}. Upload rejected.`,
      );
    }
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    return getMimeTypeFromPath(filePath);
  }
}

/**
 * Resolves a MIME type from a file extension.
 *
 * Exported so that the tool layer (src/tools/media.ts) can derive the MIME
 * type without duplicating the lookup table. The private `getMimeType` method
 * on MediaOperations delegates here.
 */
export function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
  };

  return mimeTypes[ext] || "application/octet-stream";
}
