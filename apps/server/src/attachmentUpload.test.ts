import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import { persistAttachmentUpload, validatePersistedAttachmentReference } from "./attachmentUpload";
import { resolveAttachmentPath } from "./attachmentStore.ts";

describe("attachmentUpload", () => {
  it("persists a bounded upload and validates the short RPC reference", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-"));
    try {
      const attachment = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const platformPath = yield* Path.Path;
          const persisted = yield* persistAttachmentUpload({
            type: "image",
            threadId: "thread-1",
            name: "screen.png",
            mimeType: "image/png",
            bytes: Uint8Array.from([1, 2, 3]),
            maxBytes: 10,
            attachmentsDir,
            fileSystem,
            path: platformPath,
          });
          return yield* validatePersistedAttachmentReference({
            attachment: persisted,
            threadId: "thread-1",
            attachmentsDir,
            fileSystem,
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(attachment.sizeBytes).toBe(3);
      const storedPath = resolveAttachmentPath({ attachmentsDir, attachment });
      expect(storedPath && fs.readFileSync(storedPath)).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects an oversized upload before creating a file", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-"));
    try {
      await expect(
        Effect.runPromise(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const platformPath = yield* Path.Path;
            return yield* persistAttachmentUpload({
              type: "file",
              threadId: "thread-1",
              name: "large.bin",
              mimeType: "application/octet-stream",
              bytes: Uint8Array.from([1, 2]),
              maxBytes: 1,
              attachmentsDir,
              fileSystem,
              path: platformPath,
            });
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      ).rejects.toThrow("empty or too large");
      expect(fs.readdirSync(attachmentsDir)).toEqual([]);
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
