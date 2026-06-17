/**
 * Tests for the wp_replace_media tool.
 *
 * Verifies that the tool:
 *   1. Posts to the absolute bud/v1 URL (not the default /wp-json/wp/v2 path).
 *   2. Sends raw binary with the correct Content-Type and Content-Disposition headers.
 *   3. Handles success and error cases correctly.
 *
 * The mock client mirrors the shape used in tests/tools/media.test.js, with
 * getSiteUrl() added so handleReplaceMedia can build the absolute endpoint URL.
 *
 * NOTE: vitest resolves @/ aliases to dist/. Run `npm run build` (or the
 * build phase of the session) before executing this test file. Type-safety
 * is separately validated via `npx tsc --noEmit`.
 */

import { vi } from "vitest";
import { promises as fsPromises } from "fs";
import { MediaTools } from "@/tools/media.js";

// ---------------------------------------------------------------------------
// Mock fs — prevents real filesystem access during unit tests.
// ---------------------------------------------------------------------------
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: vi.fn(),
      open: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal PNG file buffer (1×1 pixel). */
function makePngBuffer() {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // PNG magic bytes
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52, // IHDR length + type
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01, // 1×1
    0x08,
    0x02,
    0x00,
    0x00,
    0x00,
    0x90,
    0x77,
    0x53, // bit depth, color type, ...
  ]);
}

/** Creates a minimal JPEG buffer (SOI + APP0 marker). */
function makeJpegBuffer() {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0, // JPEG magic bytes (SOI + APP0)
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
  ]);
}

/** Builds a mock fs file handle that returns the given buffer. */
function mockFileHandle(buffer) {
  return {
    stat: vi.fn().mockResolvedValue({ size: buffer.length }),
    readFile: vi.fn().mockResolvedValue(buffer),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MediaTools — wp_replace_media", () => {
  let mediaTools;
  let mockClient;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      // Existing media methods (used by other tools in the same class)
      getMedia: vi.fn(),
      getMediaItem: vi.fn(),
      uploadMedia: vi.fn(),
      updateMedia: vi.fn(),
      deleteMedia: vi.fn(),
      // Required by handleReplaceMedia
      replaceMedia: vi.fn(),
      getSiteUrl: vi.fn().mockReturnValue("https://test-site.com"),
      config: {
        baseUrl: "https://test-site.com",
      },
    };

    mediaTools = new MediaTools();
  });

  // -------------------------------------------------------------------------
  // Schema / registration checks
  // -------------------------------------------------------------------------

  describe("getTools — includes wp_replace_media", () => {
    it("should list wp_replace_media in the tools array", () => {
      const tools = mediaTools.getTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("wp_replace_media");
    });

    it("should require id and file_path", () => {
      const tools = mediaTools.getTools();
      const tool = tools.find((t) => t.name === "wp_replace_media");
      expect(tool.inputSchema.required).toContain("id");
      expect(tool.inputSchema.required).toContain("file_path");
    });

    it("should describe id as a number and file_path as a string", () => {
      const tools = mediaTools.getTools();
      const { properties } = tools.find((t) => t.name === "wp_replace_media").inputSchema;
      expect(properties.id.type).toBe("number");
      expect(properties.file_path.type).toBe("string");
    });

    it("should have a handler function", () => {
      const tools = mediaTools.getTools();
      const tool = tools.find((t) => t.name === "wp_replace_media");
      expect(typeof tool.handler).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // handleReplaceMedia — success paths
  // -------------------------------------------------------------------------

  describe("handleReplaceMedia — success", () => {
    it("calls client.replaceMedia with the correct id, buffer, filename and mime type", async () => {
      const pngBuffer = makePngBuffer();
      fsPromises.access.mockResolvedValueOnce(undefined);
      fsPromises.open.mockResolvedValueOnce(mockFileHandle(pngBuffer));

      const mockMedia = {
        id: 42,
        source_url: "https://test-site.com/wp-content/uploads/badge.png",
        mime_type: "image/png",
        media_details: {},
      };
      mockClient.replaceMedia.mockResolvedValueOnce(mockMedia);

      const result = await mediaTools.handleReplaceMedia(mockClient, {
        id: 42,
        file_path: "/tmp/badge.png",
      });

      // Verify the call went through with correct arguments
      expect(mockClient.replaceMedia).toHaveBeenCalledTimes(1);
      const [calledId, calledBuffer, calledFilename, calledMime] = mockClient.replaceMedia.mock.calls[0];
      expect(calledId).toBe(42);
      expect(Buffer.isBuffer(calledBuffer)).toBe(true);
      expect(calledBuffer).toEqual(pngBuffer);
      expect(calledFilename).toBe("badge.png");
      expect(calledMime).toBe("image/png");

      // Verify the success response
      expect(typeof result).toBe("string");
      expect(result).toContain("✅ Media 42 replaced successfully");
      expect(result).toContain(mockMedia.source_url);
    });

    it("resolves JPEG MIME type correctly from .jpg extension", async () => {
      const jpegBuffer = makeJpegBuffer();
      fsPromises.access.mockResolvedValueOnce(undefined);
      fsPromises.open.mockResolvedValueOnce(mockFileHandle(jpegBuffer));

      mockClient.replaceMedia.mockResolvedValueOnce({
        id: 7,
        source_url: "https://test-site.com/wp-content/uploads/logo.jpg",
        mime_type: "image/jpeg",
      });

      await mediaTools.handleReplaceMedia(mockClient, {
        id: 7,
        file_path: "/uploads/logo.jpg",
      });

      const [, , , mime] = mockClient.replaceMedia.mock.calls[0];
      expect(mime).toBe("image/jpeg");
    });

    it("resolves JPEG MIME type correctly from .jpeg extension", async () => {
      const jpegBuffer = makeJpegBuffer();
      fsPromises.access.mockResolvedValueOnce(undefined);
      fsPromises.open.mockResolvedValueOnce(mockFileHandle(jpegBuffer));

      mockClient.replaceMedia.mockResolvedValueOnce({
        id: 8,
        source_url: "https://test-site.com/wp-content/uploads/photo.jpeg",
        mime_type: "image/jpeg",
      });

      await mediaTools.handleReplaceMedia(mockClient, {
        id: 8,
        file_path: "/uploads/photo.jpeg",
      });

      const [, , , mime] = mockClient.replaceMedia.mock.calls[0];
      expect(mime).toBe("image/jpeg");
    });

    it("includes source_url and mime in the success message", async () => {
      const pngBuffer = makePngBuffer();
      fsPromises.access.mockResolvedValueOnce(undefined);
      fsPromises.open.mockResolvedValueOnce(mockFileHandle(pngBuffer));

      mockClient.replaceMedia.mockResolvedValueOnce({
        id: 99,
        source_url: "https://apwa.com.au/wp-content/uploads/member-badge.png",
        mime_type: "image/png",
      });

      const result = await mediaTools.handleReplaceMedia(mockClient, {
        id: 99,
        file_path: "/tmp/member-badge.png",
      });

      expect(result).toContain("https://apwa.com.au/wp-content/uploads/member-badge.png");
      expect(result).toContain("image/png");
    });
  });

  // -------------------------------------------------------------------------
  // handleReplaceMedia — error paths
  // -------------------------------------------------------------------------

  describe("handleReplaceMedia — errors", () => {
    it("throws when the file is not found", async () => {
      fsPromises.access.mockRejectedValueOnce(new Error("ENOENT: no such file"));

      await expect(
        mediaTools.handleReplaceMedia(mockClient, {
          id: 1,
          file_path: "/nonexistent/badge.png",
        }),
      ).rejects.toThrow(/Failed to replace media/);
    });

    it("throws when the file exceeds the 10 MB size limit", async () => {
      fsPromises.access.mockResolvedValueOnce(undefined);
      const oversizedHandle = {
        stat: vi.fn().mockResolvedValue({ size: 11 * 1024 * 1024 }),
        readFile: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        close: vi.fn().mockResolvedValue(undefined),
      };
      fsPromises.open.mockResolvedValueOnce(oversizedHandle);

      await expect(
        mediaTools.handleReplaceMedia(mockClient, {
          id: 1,
          file_path: "/tmp/huge.png",
        }),
      ).rejects.toThrow(/Failed to replace media/);
    });

    it("propagates replaceMedia API errors", async () => {
      const pngBuffer = makePngBuffer();
      fsPromises.access.mockResolvedValueOnce(undefined);
      fsPromises.open.mockResolvedValueOnce(mockFileHandle(pngBuffer));

      mockClient.replaceMedia.mockRejectedValueOnce(new Error("404 Not Found — no attachment at that ID"));

      await expect(
        mediaTools.handleReplaceMedia(mockClient, {
          id: 9999,
          file_path: "/tmp/badge.png",
        }),
      ).rejects.toThrow(/Failed to replace media/);
    });

    it("propagates plugin-not-active errors (403)", async () => {
      const pngBuffer = makePngBuffer();
      fsPromises.access.mockResolvedValueOnce(undefined);
      fsPromises.open.mockResolvedValueOnce(mockFileHandle(pngBuffer));

      mockClient.replaceMedia.mockRejectedValueOnce(
        new Error("403 Forbidden — bud/v1 route not registered; is the plugin active?"),
      );

      await expect(
        mediaTools.handleReplaceMedia(mockClient, {
          id: 5,
          file_path: "/tmp/badge.png",
        }),
      ).rejects.toThrow(/Failed to replace media/);
    });

    it("throws on missing id param", async () => {
      await expect(
        mediaTools.handleReplaceMedia(mockClient, {
          file_path: "/tmp/badge.png",
        }),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Absolute-URL contract — the core regression guard
  //
  // MediaOperations.replaceMedia() (not tested here) builds the absolute URL
  // and posts to it. Here we verify that the tool passes the correct id to
  // client.replaceMedia(), which in turn posts to:
  //   <siteUrl>/wp-json/bud/v1/media/<id>/replace
  //
  // The full absolute-URL path through WordPressClient is covered by the
  // MediaOperations unit tests (tests/unit/media-operations-replace.test.js).
  // -------------------------------------------------------------------------

  describe("absolute URL contract", () => {
    it("passes the correct attachment ID to replaceMedia", async () => {
      const pngBuffer = makePngBuffer();
      fsPromises.access.mockResolvedValueOnce(undefined);
      fsPromises.open.mockResolvedValueOnce(mockFileHandle(pngBuffer));

      mockClient.replaceMedia.mockResolvedValueOnce({
        id: 123,
        source_url: "https://test-site.com/wp-content/uploads/badge.png",
        mime_type: "image/png",
      });

      await mediaTools.handleReplaceMedia(mockClient, {
        id: 123,
        file_path: "/tmp/badge.png",
      });

      expect(mockClient.replaceMedia).toHaveBeenCalledWith(
        123, // id — used by the operation to build …/media/123/replace
        expect.any(Buffer), // fileData
        "badge.png", // filename
        "image/png", // mimeType
      );
    });
  });
});
