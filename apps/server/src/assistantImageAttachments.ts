// FILE: assistantImageAttachments.ts
// Purpose: Snapshot authorized inline assistant images before their workspace disappears.
// Layer: Server attachment storage; Markdown text and inline ordering stay unchanged.
// Depends on: the managed attachment lifecycle and canonical workspace containment.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import Mime from "@effect/platform-node/Mime";
import {
  type ChatAttachment,
  type ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@synara/contracts";
import { isSupportedLocalImagePath } from "@synara/shared/localPreviewFiles";
import { isWindowsAbsolutePath } from "@synara/shared/path";
import { Cause, Effect, Option } from "effect";
import { fromMarkdown } from "mdast-util-from-markdown";

import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "./managedAttachmentPrincipal.ts";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "./managedAttachmentStore.ts";
import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "./persistence/Services/ManagedAttachments.ts";
import { isContainedPath } from "./workspace/realPathContainment.ts";

interface MarkdownNode {
  readonly type: string;
  readonly children?: readonly MarkdownNode[];
  readonly url?: string;
  readonly identifier?: string;
}

// This is the same single URI-decode used by the clients, without rebasing the alias.
function localImageReference(value: string): string | null {
  let source = value.trim();
  if (source.startsWith("file://")) {
    try {
      const url = new URL(source);
      if (url.hostname && url.hostname !== "localhost") return null;
      source = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !isWindowsAbsolutePath(source)) return null;
    try {
      source = decodeURIComponent(source);
    } catch {
      /* Literal percent paths stay literal. */
    }
  }
  return source.length > 0 &&
    source.length <= 4096 &&
    !source.includes("\0") &&
    isSupportedLocalImagePath(source)
    ? source
    : null;
}

// AST image nodes exclude code fences, inline code and ordinary links.
function imageReferences(text: string): readonly string[] {
  if (!text.includes("![") || text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return [];
  const root = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const nodes: MarkdownNode[] = [root];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node.url);
    }
    if (node.children) for (const child of node.children) nodes.push(child);
  }
  const references = new Set<string>();
  const stack: MarkdownNode[] = [root];
  while (stack.length && references.size < PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    const node = stack.pop()!;
    const url =
      node.type === "image"
        ? node.url
        : node.type === "imageReference" && node.identifier
          ? definitions.get(node.identifier)
          : undefined;
    const reference = url === undefined ? null : localImageReference(url);
    if (reference !== null) references.add(reference);
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        stack.push(node.children[index]!);
    }
  }
  return [...references];
}

// Bound reads even when a file grows while the final message is being captured.
async function readAuthorizedImage(
  sourcePath: string,
  cwd: string,
  roots: readonly string[],
): Promise<Buffer | null> {
  const realCwd = await fs.realpath(cwd).catch(() => null);
  if (!realCwd) return null;
  const requested = path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(cwd, sourcePath);
  // Preserve lexical containment across an authorized cwd alias, e.g. /tmp -> /private/tmp.
  const canonicalCwdAlias = path.resolve(realCwd, path.relative(path.resolve(cwd), requested));
  const realSource = await fs.realpath(requested).catch(() => null);
  // A lexical reference and its real target must belong to the same authorized root.
  // Discovering one sibling must not allow an unrelated in-cwd symlink to jump into it.
  if (
    !realSource ||
    !roots.some(
      (root) =>
        (isContainedPath(root, requested) || isContainedPath(root, canonicalCwdAlias)) &&
        isContainedPath(root, realSource),
    )
  )
    return null;
  const before = await fs.stat(realSource).catch(() => null);
  if (!before?.isFile() || before.size <= 0 || before.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
    return null;
  const handle = await fs.open(realSource, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      return null;
    const verifiedPath = await fs.realpath(requested).catch(() => null);
    if (verifiedPath !== realSource) return null;
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      return null;
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function imageFromBlob(blob: ManagedAttachmentBlob, sourcePath: string): ChatImageAttachment {
  return {
    type: "image",
    id: blob.attachmentId,
    sourcePath,
    name: blob.originalName,
    mimeType: blob.mimeType,
    sizeBytes: blob.sizeBytes!,
  };
}

export function cancelAssistantImageAttachments(input: {
  readonly attachmentIds: readonly string[];
  readonly repository: ManagedAttachmentRepositoryShape;
}) {
  const now = new Date().toISOString();
  return Effect.forEach(
    input.attachmentIds,
    (attachmentId) =>
      input.repository
        .cancelStaged({
          attachmentId,
          ...LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          reason: "assistant-image-completion-not-committed",
          requestedAt: now,
        })
        .pipe(Effect.ignore),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);
}

// Reservations are not durable references: the caller must claim them in assistant.complete.
export function stageAssistantImageAttachments<R = never>(input: {
  readonly text: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly cwd: string;
  readonly sourceRoots: readonly string[];
  readonly additionalSourceRoots?: Effect.Effect<readonly string[], never, R>;
  readonly attachmentsDir: string;
  readonly existingAttachments: readonly ChatAttachment[];
  readonly repository: ManagedAttachmentRepositoryShape;
}): Effect.Effect<
  {
    readonly attachments: readonly ChatImageAttachment[];
    readonly attachmentIds: readonly string[];
  },
  Error,
  R
> {
  const attemptedIds: string[] = [];
  const now = new Date().toISOString();
  return Effect.gen(function* () {
    const references = imageReferences(input.text);
    if (!references.length) return { attachments: [], attachmentIds: [] };
    const roots = yield* Effect.tryPromise(() =>
      Promise.all(input.sourceRoots.map((root) => fs.realpath(root).catch(() => null))),
    );
    const realRoots = roots.filter((root): root is string => root !== null);
    const attachments: ChatImageAttachment[] = [];
    let discoveredAdditionalRoots = false;
    for (const sourcePath of references) {
      const existing = input.existingAttachments.find(
        (attachment) => attachment.type === "image" && attachment.sourcePath === sourcePath,
      );
      // A new completion gets a new reservation identity after rejection; accepted
      // completions reuse their existing alias even after the original file disappears.
      const attachmentId =
        existing?.id ??
        `att_v2_${createHash("sha256")
          .update(JSON.stringify([input.threadId, input.messageId, sourcePath, input.commandId]))
          .digest("hex")
          .slice(0, 32)}`;
      const createdIds: string[] = [];
      const materialize = Effect.gen(function* () {
        const known = yield* input.repository.findServerOwned({
          attachmentId,
          ownerThreadId: input.threadId,
          ...LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
          now,
        });
        if (Option.isSome(known)) {
          const blob = known.value;
          return blob.kind === "image" &&
            blob.sizeBytes !== null &&
            (blob.state !== "claimed" || blob.claimMessageId === input.messageId)
            ? imageFromBlob(blob, sourcePath)
            : null;
        }
        const requested = path.isAbsolute(sourcePath)
          ? sourcePath
          : path.resolve(input.cwd, sourcePath);
        // Worktree discovery is needed only for an existing explicitly external reference.
        // A symlink escaping from inside cwd is never a reason to broaden the roots.
        if (
          input.additionalSourceRoots &&
          !discoveredAdditionalRoots &&
          !isContainedPath(path.resolve(input.cwd), requested)
        ) {
          const realCandidate = yield* Effect.tryPromise(() =>
            fs.realpath(requested).catch(() => null),
          );
          if (realCandidate && !realRoots.some((root) => isContainedPath(root, realCandidate))) {
            discoveredAdditionalRoots = true;
            const additional = yield* input.additionalSourceRoots;
            const realAdditional = yield* Effect.tryPromise(() =>
              Promise.all(additional.map((root) => fs.realpath(root).catch(() => null))),
            );
            for (const root of realAdditional)
              if (root && !realRoots.includes(root)) realRoots.push(root);
          }
        }
        const bytes = yield* Effect.tryPromise(() =>
          readAuthorizedImage(sourcePath, input.cwd, realRoots),
        );
        if (!bytes) return null;
        const mimeType = Mime.getType(sourcePath);
        if (!mimeType?.startsWith("image/")) return null;
        // Filesystem writes do not abort with the fiber. Finish the owned write before
        // cancellation can publish a cleanup job for its reservation.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const reservation = yield* reserveManagedAttachmentUpload({
              attachmentId,
              type: "image",
              threadId: input.threadId,
              name: path.basename(sourcePath),
              mimeType,
              reservedBytes: bytes.byteLength,
              now,
              principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
              repository: input.repository,
            });
            attemptedIds.push(attachmentId);
            createdIds.push(attachmentId);
            const stored = yield* persistReservedManagedAttachment({
              reservation,
              bytes,
              attachmentsDir: input.attachmentsDir,
              now,
              principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
              repository: input.repository,
            });
            return { ...stored, type: "image" as const, sourcePath };
          }),
        );
      });
      const attachment = yield* materialize.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          // Failed snapshots never discard the answer, and never remain unowned uploads.
          return cancelAssistantImageAttachments({
            attachmentIds: createdIds,
            repository: input.repository,
          }).pipe(
            Effect.andThen(Effect.logWarning("assistant image snapshot skipped")),
            Effect.as(null),
          );
        }),
      );
      if (attachment) attachments.push(attachment);
    }
    return { attachments, attachmentIds: attachments.map((attachment) => attachment.id) };
  }).pipe(
    Effect.onExit((exit) =>
      exit._tag === "Failure"
        ? cancelAssistantImageAttachments({
            attachmentIds: attemptedIds,
            repository: input.repository,
          })
        : Effect.void,
    ),
  );
}
