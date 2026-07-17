import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "../composerDraftStore";
import * as composerImageBlobStore from "./composerImageBlobStore";
import {
  buildComposerFileAttachmentsFromFiles,
  buildComposerImageAttachmentsFromFiles,
  effectiveComposerAttachmentCount,
  findPendingBlobComposerAttachments,
  hydratePendingBlobComposerAttachments,
  readFileAsDataUrl,
} from "./composerSend";

describe("composerSend attachment builders", () => {
  const originalCreateObjectUrl = URL.createObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
    vi.unstubAllGlobals();
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

  it("reads genuine empty files instead of treating them as folders", async () => {
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        error: Error | null = null;
        private readonly listeners = new Map<string, Array<() => void>>();

        addEventListener(type: string, listener: () => void) {
          const listeners = this.listeners.get(type) ?? [];
          listeners.push(listener);
          this.listeners.set(type, listeners);
        }

        readAsDataURL() {
          this.result = "data:application/octet-stream;base64,";
          for (const listener of this.listeners.get("load") ?? []) {
            listener();
          }
        }
      },
    );

    await expect(readFileAsDataUrl(new File([], ".gitkeep"))).resolves.toBe(
      "data:application/octet-stream;base64,",
    );
  });
});

describe("effectiveComposerAttachmentCount", () => {
  it("returns 0 when the draft is missing", () => {
    expect(effectiveComposerAttachmentCount(undefined)).toBe(0);
  });

  it("counts live images, files, and assistant selections", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [{ id: "image-1" }, { id: "image-2" }],
        files: [{}],
        assistantSelections: [{}],
        persistedAttachments: [],
      }),
    ).toBe(4);
  });

  it("counts a persisted attachment that has not yet hydrated into images", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [],
        files: [],
        assistantSelections: [],
        persistedAttachments: [{ id: "pending-1" }],
      }),
    ).toBe(1);
  });

  it("does not double-count a persisted attachment already hydrated into images", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [{ id: "image-1" }],
        files: [],
        assistantSelections: [],
        persistedAttachments: [{ id: "image-1" }],
      }),
    ).toBe(1);
  });

  it("mixes hydrated and pending persisted attachments correctly", () => {
    expect(
      effectiveComposerAttachmentCount({
        images: [{ id: "image-1" }],
        files: [{}],
        assistantSelections: [],
        persistedAttachments: [{ id: "image-1" }, { id: "pending-2" }],
      }),
    ).toBe(3);
  });
});

function persistedImageAttachment(
  overrides: Partial<PersistedComposerImageAttachment> = {},
): PersistedComposerImageAttachment {
  return {
    id: "appsnap-1",
    name: "capture.png",
    mimeType: "image/png",
    sizeBytes: 4,
    blobKey: "thread-1:appsnap-1",
    ...overrides,
  };
}

function composerImageAttachment(
  overrides: Partial<ComposerImageAttachment> = {},
): ComposerImageAttachment {
  const file = new File(["png"], "capture.png", { type: "image/png" });
  return {
    type: "image",
    id: "appsnap-1",
    name: "capture.png",
    mimeType: "image/png",
    sizeBytes: 4,
    previewUrl: "blob:capture.png",
    file,
    ...overrides,
  };
}

describe("findPendingBlobComposerAttachments", () => {
  it("returns blob-backed persisted attachments not yet hydrated into images", () => {
    const pending = persistedImageAttachment({ id: "pending-1" });
    const hydrated = persistedImageAttachment({ id: "hydrated-1" });

    const result = findPendingBlobComposerAttachments({
      persistedAttachments: [pending, hydrated],
      images: [composerImageAttachment({ id: "hydrated-1" })],
    });

    expect(result).toEqual([pending]);
  });

  it("ignores dataUrl-backed persisted attachments (no blobKey)", () => {
    const inlineAttachment: PersistedComposerImageAttachment = {
      id: "inline-1",
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 4,
      dataUrl: "data:x",
    };

    const result = findPendingBlobComposerAttachments({
      persistedAttachments: [inlineAttachment],
      images: [],
    });

    expect(result).toEqual([]);
  });
});

describe("hydratePendingBlobComposerAttachments", () => {
  const originalCreateObjectUrl = URL.createObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
    vi.restoreAllMocks();
  });

  it("reconstructs a ComposerImageAttachment from the stored blob", async () => {
    const blobFile = new File(["png"], "capture.png", { type: "image/png" });
    vi.spyOn(composerImageBlobStore, "readComposerImageBlob").mockResolvedValue(blobFile);

    const result = await hydratePendingBlobComposerAttachments([
      persistedImageAttachment({
        source: {
          kind: "appsnap",
          captureId: "capture-1",
          capturedAt: "2026-07-14T00:00:00.000Z",
          appName: "Notes",
          windowTitle: null,
        },
      }),
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        type: "image",
        id: "appsnap-1",
        previewUrl: "blob:capture.png",
        file: blobFile,
        source: expect.objectContaining({ kind: "appsnap", captureId: "capture-1" }),
      }),
    ]);
  });

  it("skips an attachment whose blob is missing without throwing", async () => {
    vi.spyOn(composerImageBlobStore, "readComposerImageBlob").mockResolvedValue(null);

    const result = await hydratePendingBlobComposerAttachments([persistedImageAttachment()]);

    expect(result).toEqual([]);
  });

  it("skips an attachment whose blob read rejects, without blocking the rest", async () => {
    vi.spyOn(composerImageBlobStore, "readComposerImageBlob")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new File(["png"], "ok.png", { type: "image/png" }));

    const result = await hydratePendingBlobComposerAttachments([
      persistedImageAttachment({ id: "broken" }),
      persistedImageAttachment({ id: "ok", blobKey: "thread-1:ok" }),
    ]);

    expect(result).toEqual([expect.objectContaining({ id: "ok" })]);
  });
});
