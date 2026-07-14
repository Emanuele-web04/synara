import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildComposerFileAttachmentsFromFiles,
  buildComposerImageAttachmentsFromFiles,
  buildUploadComposerAttachments,
  stageUploadComposerAttachments,
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

  it("uploads binary files outside RPC and returns persisted attachment ids", async () => {
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "image",
            id: "thread-1-11111111-1111-4111-8111-111111111111",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: imageFile.size,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const attachments = await buildUploadComposerAttachments({
      threadId: "thread-1",
      images: [
        {
          type: "image",
          id: "draft-image",
          name: imageFile.name,
          mimeType: imageFile.type,
          sizeBytes: imageFile.size,
          previewUrl: "blob:screen.png",
          file: imageFile,
        },
      ],
      files: [],
      assistantSelections: [],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/attachments/upload?"),
      expect.objectContaining({ method: "POST", body: imageFile }),
    );
    expect(attachments).toEqual([
      expect.objectContaining({ id: "thread-1-11111111-1111-4111-8111-111111111111" }),
    ]);
  });

  it("cancels an earlier staged attachment when a later sequential upload fails", async () => {
    const firstFile = new File(["one"], "one.png", { type: "image/png" });
    const secondFile = new File(["two"], "two.png", { type: "image/png" });
    const firstId = "thread-1-11111111-1111-4111-8111-111111111111";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          type: "image",
          id: firstId,
          name: firstFile.name,
          mimeType: firstFile.type,
          sizeBytes: firstFile.size,
        }, { status: 201 }),
      )
      .mockResolvedValueOnce(Response.json({ error: "Second upload failed." }, { status: 507 }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      stageUploadComposerAttachments({
        threadId: "thread-1",
        images: [
          {
            type: "image",
            id: "draft-one",
            name: firstFile.name,
            mimeType: firstFile.type,
            sizeBytes: firstFile.size,
            previewUrl: "blob:one.png",
            file: firstFile,
          },
          {
            type: "image",
            id: "draft-two",
            name: secondFile.name,
            mimeType: secondFile.type,
            sizeBytes: secondFile.size,
            previewUrl: "blob:two.png",
            file: secondFile,
          },
        ],
        files: [],
        assistantSelections: [],
      }),
    ).rejects.toThrow("Second upload failed.");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]).toEqual([
      expect.stringContaining("/api/attachments/cancel"),
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ attachmentId: firstId }),
      }),
    ]);
  });

  it("preserves the upload failure when best-effort cancellation also fails", async () => {
    const firstFile = new File(["one"], "one.png", { type: "image/png" });
    const secondFile = new File(["two"], "two.png", { type: "image/png" });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          type: "image",
          id: "thread-1-11111111-1111-4111-8111-111111111111",
          name: firstFile.name,
          mimeType: firstFile.type,
          sizeBytes: firstFile.size,
        }, { status: 201 }),
      )
      .mockResolvedValueOnce(Response.json({ error: "Original upload failure." }, { status: 500 }))
      .mockRejectedValueOnce(new Error("Cancellation transport failed."));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      stageUploadComposerAttachments({
        threadId: "thread-1",
        images: [
          {
            type: "image",
            id: "draft-one",
            name: firstFile.name,
            mimeType: firstFile.type,
            sizeBytes: firstFile.size,
            previewUrl: "blob:one.png",
            file: firstFile,
          },
          {
            type: "image",
            id: "draft-two",
            name: secondFile.name,
            mimeType: secondFile.type,
            sizeBytes: secondFile.size,
            previewUrl: "blob:two.png",
            file: secondFile,
          },
        ],
        files: [],
        assistantSelections: [],
      }),
    ).rejects.toThrow("Original upload failure.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels every staged managed attachment when dispatch rejects", async () => {
    const files = [
      new File(["one"], "one.png", { type: "image/png" }),
      new File(["two"], "two.png", { type: "image/png" }),
    ];
    const ids = [
      "thread-1-11111111-1111-4111-8111-111111111111",
      "thread-1-22222222-2222-4222-8222-222222222222",
    ];
    const fetchMock = vi.fn<typeof fetch>();
    for (const [index, file] of files.entries()) {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          type: "image",
          id: ids[index],
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }, { status: 201 }),
      );
    }
    fetchMock
      .mockResolvedValueOnce(Response.json({ cancelled: true }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const staged = await stageUploadComposerAttachments({
      threadId: "thread-1",
      images: files.map((file, index) => ({
        type: "image" as const,
        id: `draft-${index}`,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: `blob:${file.name}`,
        file,
      })),
      files: [],
      assistantSelections: [],
    });
    const dispatchError = new Error("Dispatch rejected.");

    await expect(staged.runWithDispatch(async () => Promise.reject(dispatchError))).rejects.toBe(
      dispatchError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const cancelledIds = fetchMock.mock.calls
      .slice(2)
      .map(([, options]) => JSON.parse(String(options?.body)).attachmentId)
      .sort();
    expect(cancelledIds).toEqual(ids.toSorted());
  });

  it("commits successful dispatches so later cleanup does not cancel", async () => {
    const imageFile = new File(["png"], "screen.png", { type: "image/png" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        type: "image",
        id: "thread-1-11111111-1111-4111-8111-111111111111",
        name: imageFile.name,
        mimeType: imageFile.type,
        sizeBytes: imageFile.size,
      }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const staged = await stageUploadComposerAttachments({
      threadId: "thread-1",
      images: [
        {
          type: "image",
          id: "draft-image",
          name: imageFile.name,
          mimeType: imageFile.type,
          sizeBytes: imageFile.size,
          previewUrl: "blob:screen.png",
          file: imageFile,
        },
      ],
      files: [],
      assistantSelections: [],
    });

    await expect(staged.runWithDispatch(async () => "accepted")).resolves.toBe("accepted");
    await staged.cleanup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
