import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type HubWorkSourceMessage,
} from "@synara/contracts";
import { Effect, Option } from "effect";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import type { ManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import {
  ManagedAttachmentStoreError,
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
  type BinaryChatAttachment,
} from "../managedAttachmentStore.ts";
import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";
import { resolveRealPathWithinRoot } from "../workspace/realPathContainment.ts";

interface CloneInput {
  readonly sourceMessages: readonly HubWorkSourceMessage[];
  readonly targetThreadId: string;
  readonly targetMessageId: string;
  readonly dispatchKey: string;
  readonly attachmentsDir: string;
  readonly principal: ManagedAttachmentPrincipal;
  readonly repository: ManagedAttachmentRepositoryShape;
  readonly now?: string;
}

interface SourceAttachment {
  readonly threadId: string;
  readonly messageId: string;
  readonly attachment: ChatAttachment;
}

function unavailableAttachment(attachmentId: string, cause?: unknown) {
  return new ManagedAttachmentStoreError(
    `Attachment '${attachmentId}' is unavailable for delegation. Reattach it and retry.`,
    {
      status: 409,
      code: "attachment_source_unavailable",
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function attachmentFromBlob(blob: ManagedAttachmentBlob): BinaryChatAttachment {
  if ((blob.kind !== "file" && blob.kind !== "image") || blob.sizeBytes === null) {
    throw unavailableAttachment(blob.attachmentId);
  }
  return {
    type: blob.kind,
    id: blob.attachmentId,
    name: blob.originalName,
    mimeType: blob.mimeType,
    sizeBytes: blob.sizeBytes,
  };
}

function cloneIdentity(input: CloneInput, source: SourceAttachment): string {
  const identity = JSON.stringify([
    input.dispatchKey,
    input.targetThreadId,
    input.targetMessageId,
    source.threadId,
    source.messageId,
    source.attachment.id,
  ]);
  return `att_v2_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function readBinaryAttachment(input: {
  readonly attachmentsDir: string;
  readonly storagePath: string | null;
  readonly attachment: BinaryChatAttachment;
  readonly expectedHash: string | null;
}) {
  return Effect.tryPromise({
    try: async () => {
      if (!input.storagePath) throw unavailableAttachment(input.attachment.id);
      const realPath = await resolveRealPathWithinRoot(input.attachmentsDir, input.storagePath);
      if (!realPath) throw unavailableAttachment(input.attachment.id);
      const limit =
        input.attachment.type === "image"
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      const stat = await fs.stat(realPath);
      if (
        !stat.isFile() ||
        stat.size !== input.attachment.sizeBytes ||
        stat.size === 0 ||
        stat.size > limit
      ) {
        throw unavailableAttachment(input.attachment.id);
      }
      const bytes = await fs.readFile(realPath);
      if (
        bytes.length !== input.attachment.sizeBytes ||
        bytes.length === 0 ||
        (input.expectedHash !== null &&
          createHash("sha256").update(bytes).digest("hex") !== input.expectedHash)
      ) {
        throw unavailableAttachment(input.attachment.id);
      }
      return bytes;
    },
    catch: (cause) => unavailableAttachment(input.attachment.id, cause),
  });
}

function loadSourceAttachment(input: CloneInput, source: SourceAttachment) {
  return Effect.gen(function* () {
    if (source.attachment.type === "assistant-selection") {
      return { source, attachment: source.attachment, bytes: null };
    }
    let attachment: BinaryChatAttachment = source.attachment;
    let storagePath: string | null;
    let expectedHash: string | null = null;
    if (attachment.id.startsWith("att_v2_")) {
      const found = yield* input.repository.findClaimedById({ attachmentId: attachment.id });
      if (
        Option.isNone(found) ||
        found.value.ownerThreadId !== source.threadId ||
        found.value.claimMessageId !== source.messageId ||
        found.value.kind !== attachment.type ||
        !found.value.sha256
      ) {
        return yield* Effect.fail(unavailableAttachment(attachment.id));
      }
      const blob = found.value;
      attachment = yield* Effect.try({
        try: () => attachmentFromBlob(blob),
        catch: () => unavailableAttachment(blob.attachmentId),
      });
      expectedHash = blob.sha256;
      storagePath = resolveAttachmentRelativePath({
        attachmentsDir: input.attachmentsDir,
        relativePath: blob.relativePath,
      });
    } else {
      storagePath = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
    }
    const bytes = yield* readBinaryAttachment({
      attachmentsDir: input.attachmentsDir,
      storagePath,
      attachment,
      expectedHash,
    });
    return { source, attachment, bytes };
  });
}

function stageClone(
  input: CloneInput,
  loaded: { source: SourceAttachment; attachment: BinaryChatAttachment; bytes: Uint8Array },
  now: string,
) {
  return Effect.gen(function* () {
    const attachmentId = cloneIdentity(input, loaded.source);
    const existing = yield* input.repository.findServerOwned({
      attachmentId,
      ownerThreadId: input.targetThreadId,
      ownerKind: input.principal.ownerKind,
      ownerId: input.principal.ownerId,
      now,
    });
    if (Option.isSome(existing)) {
      const blob = existing.value;
      if (
        (blob.state === "claimed" && blob.claimMessageId !== input.targetMessageId) ||
        blob.kind !== loaded.attachment.type ||
        blob.sizeBytes !== loaded.bytes.byteLength ||
        blob.sha256 !== createHash("sha256").update(loaded.bytes).digest("hex")
      ) {
        return yield* Effect.fail(unavailableAttachment(attachmentId));
      }
      const attachment = yield* Effect.try({
        try: () => attachmentFromBlob(blob),
        catch: () => unavailableAttachment(attachmentId),
      });
      yield* readBinaryAttachment({
        attachmentsDir: input.attachmentsDir,
        storagePath: resolveAttachmentRelativePath({
          attachmentsDir: input.attachmentsDir,
          relativePath: blob.relativePath,
        }),
        attachment,
        expectedHash: blob.sha256,
      });
      return attachment;
    }
    const reservation = yield* reserveManagedAttachmentUpload({
      attachmentId,
      type: loaded.attachment.type,
      threadId: input.targetThreadId,
      name: loaded.attachment.name,
      mimeType: loaded.attachment.mimeType,
      reservedBytes: loaded.bytes.byteLength,
      now,
      principal: input.principal,
      repository: input.repository,
    });
    return yield* persistReservedManagedAttachment({
      reservation,
      bytes: loaded.bytes,
      attachmentsDir: input.attachmentsDir,
      now,
      principal: input.principal,
      repository: input.repository,
    });
  });
}

/** Source messages must already be resolved and authorized by the Hub routing service. */
export function cloneDelegatedAttachments(input: CloneInput) {
  return Effect.gen(function* () {
    const sources = input.sourceMessages.flatMap((message) =>
      message.attachments.map((attachment) => ({
        threadId: message.threadId,
        messageId: message.messageId,
        attachment,
      })),
    );
    if (sources.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return yield* Effect.fail(
        new ManagedAttachmentStoreError(
          "Delegation exceeds the attachment limit. Select fewer source messages.",
          { status: 400, code: "attachment_count_exceeded" },
        ),
      );
    }
    const loaded = yield* Effect.forEach(sources, (source) => loadSourceAttachment(input, source), {
      concurrency: 1,
    });
    const now = input.now ?? new Date().toISOString();
    return yield* Effect.forEach(
      loaded,
      (entry) =>
        entry.attachment.type === "assistant-selection" || entry.bytes === null
          ? Effect.succeed<ChatAttachment>(entry.attachment)
          : stageClone(
              input,
              { source: entry.source, attachment: entry.attachment, bytes: entry.bytes },
              now,
            ),
      { concurrency: 1 },
    );
  });
}
