import type { ChatFileAttachment, ChatImageAttachment } from "@synara/contracts";
import type { FileSystem, Path } from "effect";
import { Effect } from "effect";

import {
  createAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "./attachmentStore.ts";
import { repairPrivateFile } from "./privatePathPermissions";

export type BinaryChatAttachment = ChatImageAttachment | ChatFileAttachment;

export function persistAttachmentUpload(input: {
  readonly type: "image" | "file";
  readonly threadId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly maxBytes: number;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.Effect<BinaryChatAttachment, Error> {
  return Effect.gen(function* () {
    const mimeType = input.mimeType.trim().toLowerCase();
    if (!mimeType || mimeType.length > 100) {
      return yield* Effect.fail(new Error("Attachment MIME type is invalid."));
    }
    if (input.type === "image" && !mimeType.startsWith("image/")) {
      return yield* Effect.fail(new Error("Image attachments require an image MIME type."));
    }
    const name = input.name.trim();
    if (!name || name.length > 255) {
      return yield* Effect.fail(new Error("Attachment name is invalid."));
    }
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > input.maxBytes) {
      return yield* Effect.fail(new Error("Attachment is empty or too large."));
    }

    const id = createAttachmentId(input.threadId);
    if (!id) return yield* Effect.fail(new Error("Attachment thread id is invalid."));
    const attachment: BinaryChatAttachment = {
      type: input.type,
      id,
      name,
      mimeType,
      sizeBytes: input.bytes.byteLength,
    };
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* Effect.fail(new Error("Attachment path could not be resolved."));
    }

    yield* input.fileSystem.makeDirectory(input.path.dirname(attachmentPath), { recursive: true });
    yield* input.fileSystem.writeFile(attachmentPath, input.bytes);
    yield* Effect.tryPromise({
      try: () => repairPrivateFile(attachmentPath),
      catch: (cause) => new Error("Failed to secure persisted attachment.", { cause }),
    }).pipe(
      Effect.catch((error) =>
        input.fileSystem
          .remove(attachmentPath, { force: true })
          .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
      ),
    );
    return attachment;
  });
}

export function validatePersistedAttachmentReference(input: {
  readonly attachment: BinaryChatAttachment;
  readonly threadId: string;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<BinaryChatAttachment, Error> {
  return Effect.gen(function* () {
    const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
    const expectedPrefix = threadSegment ? `${threadSegment}-` : null;
    if (!expectedPrefix || !input.attachment.id.startsWith(expectedPrefix)) {
      return yield* Effect.fail(new Error("Attachment does not belong to this thread."));
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment: input.attachment,
    });
    if (!attachmentPath) return yield* Effect.fail(new Error("Attachment reference is invalid."));
    const info = yield* input.fileSystem
      .stat(attachmentPath)
      .pipe(Effect.mapError(() => new Error("Uploaded attachment could not be found.")));
    if (info.type !== "File" || Number(info.size) !== input.attachment.sizeBytes) {
      return yield* Effect.fail(new Error("Uploaded attachment metadata does not match its file."));
    }
    return input.attachment;
  });
}
