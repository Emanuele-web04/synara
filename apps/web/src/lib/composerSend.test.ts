import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildComposerFileAttachmentsFromFiles,
  buildComposerImageAttachmentsFromFiles,
} from "./composerSend";

describe("composerSend attachment builders", () => {
  const originalCreateObjectUrl = URL.createObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
  });

  it("keeps image-specific unsupported-file errors while sharing cap handling", () => {
    const textFile = new File(["hello"], "notes.txt", { type: "text/plain" });
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });

    const result = buildComposerImageAttachmentsFromFiles({
      files: [textFile, imageFile],
      existingAttachmentCount: 0,
    });

    expect(result.error).toBe(
      "Unsupported file type for 'notes.txt'. Please attach image files only.",
    );
    expect(result.images).toEqual([
      expect.objectContaining({
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        previewUrl: "blob:screen.png",
      }),
    ]);
  });

  it("builds generic file attachments and skips images without an error", () => {
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });
    const unknownFile = new File(["data"], "payload.bin", { type: "" });

    const result = buildComposerFileAttachmentsFromFiles({
      files: [imageFile, unknownFile],
      existingAttachmentCount: 0,
    });

    expect(result.error).toBeNull();
    expect(result.files).toEqual([
      expect.objectContaining({
        type: "file",
        name: "payload.bin",
        mimeType: "application/octet-stream",
        sizeBytes: unknownFile.size,
        file: unknownFile,
      }),
    ]);
  });

  it("enforces the shared attachment count cap for generic files", () => {
    const result = buildComposerFileAttachmentsFromFiles({
      files: [new File(["data"], "notes.txt", { type: "text/plain" })],
      existingAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    });

    expect(result.files).toEqual([]);
    expect(result.error).toBe(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
    );
  });
});
