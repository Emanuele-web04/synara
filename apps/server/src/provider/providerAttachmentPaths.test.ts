import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProviderSendTurnInput, ThreadId, type ChatAttachment } from "@synara/contracts";
import { Effect, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";
import {
  carryProviderAttachmentPaths,
  resolveProviderAttachmentPath,
  resolveProviderDispatchAttachments,
} from "./providerAttachmentPaths.ts";
import { loadProviderPromptImageBlocks } from "./promptAttachments.ts";
import { buildFileAttachmentsPromptBlock } from "./attachmentProjection.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const MESSAGE_ID = "message-1";
const roots = new Set<string>();

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-attachment-paths-"));
  roots.add(root);
  return root;
}

function managedBlob(input: {
  readonly attachmentId: string;
  readonly kind: "image" | "file";
  readonly relativePath: string;
  readonly ownerThreadId?: string;
  readonly claimMessageId?: string | null;
}): ManagedAttachmentBlob {
  return {
    attachmentId: input.attachmentId,
    ownerThreadId: input.ownerThreadId ?? THREAD_ID,
    ownerKind: "local-loopback",
    ownerId: "local-loopback",
    kind: input.kind,
    originalName: input.kind === "image" ? "photo.png" : "notes.txt",
    mimeType: input.kind === "image" ? "image/png" : "text/plain",
    reservedBytes: 4,
    sizeBytes: 4,
    sha256: "0".repeat(64),
    relativePath: input.relativePath,
    state: "claimed",
    stagingExpiresAt: null,
    claimCommandId: "command-1",
    claimMessageId: input.claimMessageId ?? MESSAGE_ID,
    claimedAt: "2026-07-17T12:00:00.000Z",
    deleteReason: null,
    deleteRequestedAt: null,
    deletedAt: null,
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
  };
}

function repositoryWith(blob: ManagedAttachmentBlob | null) {
  return {
    findClaimedById: () => Effect.succeed(Option.fromNullishOr(blob)),
  } satisfies Pick<ManagedAttachmentRepositoryShape, "findClaimedById">;
}

function resolve(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
  readonly blob: ManagedAttachmentBlob | null;
}) {
  return resolveProviderDispatchAttachments({
    attachments: [input.attachment],
    attachmentsDir: input.attachmentsDir,
    repository: repositoryWith(input.blob),
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    provider: "codex",
    operation: "thread.turn.start",
  });
}

afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  roots.clear();
});

describe("provider attachment paths", () => {
  it.each([
    {
      kind: "image" as const,
      id: "att_v2_01000000000000000000000000000000",
      extension: ".png",
      type: "image" as const,
      name: "client-name.png",
      mimeType: "image/png",
    },
    {
      kind: "file" as const,
      id: "att_v2_02000000000000000000000000000000",
      extension: ".txt",
      type: "file" as const,
      name: "client-name.txt",
      mimeType: "text/plain",
    },
  ])("resolves a claimed managed $kind through its repository storage path", async (fixture) => {
    const attachmentsDir = makeRoot();
    const relativePath = `objects/${fixture.id.slice(7, 9)}/${fixture.id}${fixture.extension}`;
    const storagePath = path.join(attachmentsDir, relativePath);
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, "data");
    const blob = managedBlob({
      attachmentId: fixture.id,
      kind: fixture.kind,
      relativePath,
    });

    const [resolved] = await Effect.runPromise(
      resolve({
        attachmentsDir,
        attachment: {
          type: fixture.type,
          id: fixture.id,
          name: fixture.name,
          mimeType: fixture.mimeType,
          sizeBytes: 4,
        },
        blob,
      }),
    );

    expect(resolved).toMatchObject({
      type: fixture.type,
      id: fixture.id,
      name: blob.originalName,
      mimeType: blob.mimeType,
      sizeBytes: 4,
    });
    expect(
      resolved && resolveProviderAttachmentPath({ attachmentsDir, attachment: resolved }),
    ).toBe(storagePath);
  });

  it("keeps legacy flat-file attachments working", async () => {
    const attachmentsDir = makeRoot();
    const attachment: ChatAttachment = {
      type: "file",
      id: "thread-1-legacy-file",
      name: "legacy.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
    };
    const storagePath = path.join(attachmentsDir, `${attachment.id}.txt`);
    fs.writeFileSync(storagePath, "data");

    const [resolved] = await Effect.runPromise(resolve({ attachmentsDir, attachment, blob: null }));

    expect(
      resolved && resolveProviderAttachmentPath({ attachmentsDir, attachment: resolved }),
    ).toBe(storagePath);
  });

  it("feeds managed images to native image inputs and managed files to prompt paths", async () => {
    const attachmentsDir = makeRoot();
    const imageId = "att_v2_11000000000000000000000000000000";
    const fileId = "att_v2_12000000000000000000000000000000";
    const imageRelativePath = `objects/11/${imageId}.png`;
    const fileRelativePath = `objects/12/${fileId}.txt`;
    const imagePath = path.join(attachmentsDir, imageRelativePath);
    const filePath = path.join(attachmentsDir, fileRelativePath);
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(filePath, "note");
    const blobs = new Map([
      [
        imageId,
        managedBlob({ attachmentId: imageId, kind: "image", relativePath: imageRelativePath }),
      ],
      [fileId, managedBlob({ attachmentId: fileId, kind: "file", relativePath: fileRelativePath })],
    ]);
    const repository = {
      findClaimedById: ({ attachmentId }: { readonly attachmentId: string }) =>
        Effect.succeed(Option.fromNullishOr(blobs.get(attachmentId))),
    } satisfies Pick<ManagedAttachmentRepositoryShape, "findClaimedById">;
    const attachments = await Effect.runPromise(
      resolveProviderDispatchAttachments({
        attachments: [
          {
            type: "image",
            id: imageId,
            name: "photo.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
          {
            type: "file",
            id: fileId,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ],
        attachmentsDir,
        repository,
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        provider: "codex",
        operation: "thread.turn.start",
      }),
    );
    const readPaths: string[] = [];
    const imageBlocks = await Effect.runPromise(
      loadProviderPromptImageBlocks({
        attachments,
        attachmentsDir,
        provider: "codex",
        method: "turn/start",
        readFile: (filePath) =>
          Effect.tryPromise(async () => {
            readPaths.push(filePath);
            return fs.promises.readFile(filePath);
          }),
      }),
    );
    const filePrompt = buildFileAttachmentsPromptBlock({
      attachments,
      attachmentsDir,
      include: "all-files",
    });

    expect(readPaths).toEqual([imagePath]);
    expect(imageBlocks).toEqual([
      { type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") },
    ]);
    expect(filePrompt).toContain(filePath);
    expect(filePrompt).not.toContain(path.join(attachmentsDir, `${fileId}.txt`));
  });

  it.each([
    { label: "missing or deleted record", blob: null },
    {
      label: "another thread's claim",
      blob: managedBlob({
        attachmentId: "att_v2_03000000000000000000000000000000",
        kind: "image",
        relativePath: "objects/03/att_v2_03000000000000000000000000000000.png",
        ownerThreadId: "thread-2",
      }),
    },
    {
      label: "another message's claim",
      blob: managedBlob({
        attachmentId: "att_v2_03000000000000000000000000000000",
        kind: "image",
        relativePath: "objects/03/att_v2_03000000000000000000000000000000.png",
        claimMessageId: "message-2",
      }),
    },
  ])("rejects a managed attachment with $label", async ({ blob }) => {
    const attachmentsDir = makeRoot();
    const id = "att_v2_03000000000000000000000000000000";
    const storagePath = path.join(attachmentsDir, "objects/03", `${id}.png`);
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, "data");

    const exit = await Effect.runPromiseExit(
      resolve({
        attachmentsDir,
        attachment: {
          type: "image",
          id,
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 4,
        },
        blob,
      }),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("rejects a claimed managed attachment whose storage object is missing", async () => {
    const attachmentsDir = makeRoot();
    const id = "att_v2_04000000000000000000000000000000";
    const blob = managedBlob({
      attachmentId: id,
      kind: "file",
      relativePath: `objects/04/${id}.txt`,
    });

    await expect(
      Effect.runPromise(
        resolve({
          attachmentsDir,
          attachment: {
            type: "file",
            id,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
          blob,
        }),
      ),
    ).rejects.toThrow("unavailable for this message");
  });

  it("carries only the server-resolved path through provider schema decoding", async () => {
    const attachmentsDir = makeRoot();
    const id = "att_v2_05000000000000000000000000000000";
    const relativePath = `objects/05/${id}.png`;
    const storagePath = path.join(attachmentsDir, relativePath);
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, "data");
    const rawAttachments = await Effect.runPromise(
      resolve({
        attachmentsDir,
        attachment: {
          type: "image",
          id,
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 4,
        },
        blob: managedBlob({ attachmentId: id, kind: "image", relativePath }),
      }),
    );
    const rawInput = { threadId: THREAD_ID, input: "inspect", attachments: rawAttachments };
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(ProviderSendTurnInput)(rawInput),
    );
    const [carried] = carryProviderAttachmentPaths(rawInput, decoded.attachments ?? []);

    expect(carried && resolveProviderAttachmentPath({ attachmentsDir, attachment: carried })).toBe(
      storagePath,
    );
  });
});
