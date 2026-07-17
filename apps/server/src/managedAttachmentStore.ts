import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ChatFileAttachment, ChatImageAttachment } from "@synara/contracts";
import { Effect } from "effect";

import { resolveAttachmentRelativePath } from "./attachmentPaths";
import { inferAttachmentExtension, inferImageExtension } from "./imageMime";
import type { ManagedAttachmentPrincipal } from "./managedAttachmentPrincipal";
import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "./persistence/Services/ManagedAttachments";
import {
  ensurePrivateDirectorySync,
  repairPrivateFile,
  syncDirectoryEntry,
} from "./privatePathPermissions";

export const MANAGED_ATTACHMENT_STAGING_TTL_MS = 60 * 60 * 1_000;
const MANAGED_ATTACHMENT_ID_PREFIX = "att_v2_";

export type BinaryChatAttachment = ChatImageAttachment | ChatFileAttachment;

export class ManagedAttachmentStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status: number; code: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ManagedAttachmentStoreError";
    this.status = options.status;
    this.code = options.code;
  }
}

function validateMetadata(input: {
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
}) {
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!mimeType || mimeType.length > 100) {
    throw new ManagedAttachmentStoreError("Attachment MIME type is invalid.", {
      status: 400,
      code: "attachment_metadata_invalid",
    });
  }
  if (input.type === "image" && !mimeType.startsWith("image/")) {
    throw new ManagedAttachmentStoreError("Image attachments require an image MIME type.", {
      status: 400,
      code: "attachment_metadata_invalid",
    });
  }
  const name = input.name.trim();
  if (!name || name.length > 255 || /[\u0000\r\n]/u.test(name)) {
    throw new ManagedAttachmentStoreError("Attachment name is invalid.", {
      status: 400,
      code: "attachment_metadata_invalid",
    });
  }
  return { name, mimeType };
}

function extensionFor(input: {
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
}): string {
  return input.type === "image"
    ? inferImageExtension({ mimeType: input.mimeType, fileName: input.name })
    : inferAttachmentExtension({ mimeType: input.mimeType, fileName: input.name });
}

export function reserveManagedAttachmentUpload(input: {
  readonly type: "image" | "file";
  readonly threadId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly reservedBytes: number;
  readonly now: string;
  readonly principal: ManagedAttachmentPrincipal;
  readonly repository: ManagedAttachmentRepositoryShape;
}) {
  return Effect.gen(function* () {
    const metadata = yield* Effect.try({
      try: () => validateMetadata(input),
      catch: (cause) =>
        cause instanceof ManagedAttachmentStoreError
          ? cause
          : new ManagedAttachmentStoreError("Attachment metadata is invalid.", {
              status: 400,
              code: "attachment_metadata_invalid",
              cause,
            }),
    });
    const attachmentId = `${MANAGED_ATTACHMENT_ID_PREFIX}${randomUUID().replaceAll("-", "")}`;
    const extension = extensionFor({ type: input.type, ...metadata });
    const relativePath = `objects/${attachmentId.slice(MANAGED_ATTACHMENT_ID_PREFIX.length, MANAGED_ATTACHMENT_ID_PREFIX.length + 2)}/${attachmentId}${extension}`;
    const result = yield* input.repository.reserve({
      attachmentId,
      ownerThreadId: input.threadId,
      ownerKind: input.principal.ownerKind,
      ownerId: input.principal.ownerId,
      kind: input.type,
      originalName: metadata.name,
      mimeType: metadata.mimeType,
      reservedBytes: input.reservedBytes,
      relativePath,
      now: input.now,
    });
    if (result.status === "quota-exceeded") {
      return yield* Effect.fail(
        new ManagedAttachmentStoreError("Managed attachment storage quota exceeded.", {
          status: 507,
          code: "attachment_quota_exceeded",
        }),
      );
    }
    if (result.status !== "reserved") {
      return yield* Effect.fail(
        new ManagedAttachmentStoreError("Could not reserve attachment storage.", {
          status: 409,
          code: "attachment_reservation_conflict",
        }),
      );
    }
    return result.attachment;
  });
}

export function persistReservedManagedAttachment(input: {
  readonly reservation: ManagedAttachmentBlob;
  readonly bytes: Uint8Array;
  readonly attachmentsDir: string;
  readonly now: string;
  readonly principal: ManagedAttachmentPrincipal;
  readonly repository: ManagedAttachmentRepositoryShape;
}): Effect.Effect<BinaryChatAttachment, Error> {
  return Effect.gen(function* () {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > input.reservation.reservedBytes) {
      yield* input.repository
        .cancelStaged({
          attachmentId: input.reservation.attachmentId,
          ownerKind: input.principal.ownerKind,
          ownerId: input.principal.ownerId,
          reason: "upload-size-mismatch",
          requestedAt: input.now,
        })
        .pipe(Effect.ignore);
      return yield* Effect.fail(
        new ManagedAttachmentStoreError("Attachment is empty or larger than its reservation.", {
          status: 413,
          code: "attachment_size_mismatch",
        }),
      );
    }
    const finalPath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: input.reservation.relativePath,
    });
    if (!finalPath) {
      return yield* Effect.fail(
        new ManagedAttachmentStoreError("Attachment storage path is invalid.", {
          status: 500,
          code: "attachment_path_invalid",
        }),
      );
    }
    const stagingDir = path.join(input.attachmentsDir, ".staging");
    const temporaryPath = path.join(stagingDir, `${input.reservation.attachmentId}.part`);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");

    const writeResult = yield* Effect.exit(
      Effect.tryPromise({
        try: async () => {
          ensurePrivateDirectorySync(input.attachmentsDir);
          ensurePrivateDirectorySync(stagingDir);
          ensurePrivateDirectorySync(path.dirname(finalPath));
          const handle = await fs.open(temporaryPath, "wx", 0o600);
          try {
            await handle.writeFile(input.bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await repairPrivateFile(temporaryPath);
          await fs.rename(temporaryPath, finalPath);
          // The blob must be durable before the SQLite row can become staged.
          // Flush the final entry and every managed ancestor that may have
          // been created for this content-addressed path.
          const attachmentsRoot = path.resolve(input.attachmentsDir);
          let directoryToSync = path.dirname(finalPath);
          while (true) {
            await syncDirectoryEntry(directoryToSync);
            if (directoryToSync === attachmentsRoot) break;
            const parent = path.dirname(directoryToSync);
            if (
              parent === directoryToSync ||
              (parent !== attachmentsRoot && !parent.startsWith(`${attachmentsRoot}${path.sep}`))
            ) {
              throw new Error("Managed attachment directory escaped its storage root.");
            }
            directoryToSync = parent;
          }
        },
        catch: (cause) =>
          new ManagedAttachmentStoreError("Failed to persist attachment bytes.", {
            status: 500,
            code: "attachment_write_failed",
            cause,
          }),
      }),
    );
    if (writeResult._tag === "Failure") {
      yield* input.repository
        .cancelStaged({
          attachmentId: input.reservation.attachmentId,
          ownerKind: input.principal.ownerKind,
          ownerId: input.principal.ownerId,
          reason: "upload-write-failed",
          requestedAt: input.now,
        })
        .pipe(Effect.ignore);
      yield* Effect.tryPromise({
        try: () => fs.unlink(temporaryPath),
        catch: () => undefined,
      }).pipe(Effect.ignore);
      return yield* Effect.failCause(writeResult.cause);
    }

    const stagingExpiresAt = new Date(
      Date.parse(input.now) + MANAGED_ATTACHMENT_STAGING_TTL_MS,
    ).toISOString();
    const finalized = yield* input.repository.finalizeStaged({
      attachmentId: input.reservation.attachmentId,
      ownerThreadId: input.reservation.ownerThreadId,
      ownerKind: input.principal.ownerKind,
      ownerId: input.principal.ownerId,
      sizeBytes: input.bytes.byteLength,
      sha256,
      stagingExpiresAt,
      now: input.now,
    });
    if (finalized.status !== "staged") {
      yield* input.repository.cancelStaged({
        attachmentId: input.reservation.attachmentId,
        ownerKind: input.principal.ownerKind,
        ownerId: input.principal.ownerId,
        reason: "upload-finalize-failed",
        requestedAt: input.now,
      });
      return yield* Effect.fail(
        new ManagedAttachmentStoreError("Attachment reservation expired before finalization.", {
          status: 409,
          code: "attachment_reservation_expired",
        }),
      );
    }
    return {
      type: finalized.attachment.kind as "image" | "file",
      id: finalized.attachment.attachmentId,
      name: finalized.attachment.originalName,
      mimeType: finalized.attachment.mimeType,
      sizeBytes: finalized.attachment.sizeBytes!,
    };
  });
}
