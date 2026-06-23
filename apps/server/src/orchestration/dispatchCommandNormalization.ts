import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ClientOrchestrationCommand,
  type ChatAttachment,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import type { FileSystem, Path } from "effect";
import { Effect } from "effect";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore";

interface UploadBinaryAttachmentInput {
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

function parseBinaryAttachmentDataUrl(
  dataUrl: string,
): { readonly mimeType: string; readonly base64: string } | null {
  const match = /^data:([^,]*),([a-z0-9+/=\r\n ]+)$/i.exec(dataUrl.trim());
  if (!match) return null;

  const headerParts = (match[1] ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const trailingToken = headerParts.at(-1)?.toLowerCase();
  if (trailingToken !== "base64") {
    return null;
  }

  const mimeType = headerParts[0]?.toLowerCase() ?? "";
  const base64 = match[2]?.replace(/\s+/g, "");
  if (!base64) return null;

  return { mimeType, base64 };
}

function persistBinaryAttachment(input: {
  readonly attachment: UploadBinaryAttachmentInput;
  readonly threadId: string;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly maxBytes: number;
  readonly requireImageMime: boolean;
  readonly trackAttachmentPath?: ((path: string) => void) | undefined;
}): Effect.Effect<ChatAttachment, Error, never> {
  return Effect.gen(function* () {
    const parsed = parseBinaryAttachmentDataUrl(input.attachment.dataUrl);
    const parsedMimeType =
      parsed?.mimeType && parsed.mimeType.length > 0
        ? parsed.mimeType.toLowerCase()
        : "application/octet-stream";
    if (!parsed || (input.requireImageMime && !parsedMimeType.startsWith("image/"))) {
      return yield* Effect.fail(
        new Error(
          `Invalid ${input.attachment.type} attachment payload for '${input.attachment.name}'.`,
        ),
      );
    }

    const bytes = Buffer.from(parsed.base64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > input.maxBytes) {
      const label = input.attachment.type === "image" ? "Image" : "File";
      return yield* Effect.fail(
        new Error(`${label} attachment '${input.attachment.name}' is empty or too large.`),
      );
    }

    const attachmentId = createAttachmentId(input.threadId);
    if (!attachmentId) {
      return yield* Effect.fail(new Error("Failed to create a safe attachment id."));
    }

    const persistedAttachment: ChatAttachment =
      input.attachment.type === "image"
        ? {
            type: "image",
            id: attachmentId,
            name: input.attachment.name,
            mimeType: parsedMimeType,
            sizeBytes: bytes.byteLength,
          }
        : {
            type: "file",
            id: attachmentId,
            name: input.attachment.name,
            mimeType: parsedMimeType,
            sizeBytes: bytes.byteLength,
          };

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment: persistedAttachment,
    });
    if (!attachmentPath) {
      return yield* Effect.fail(
        new Error(`Failed to resolve persisted path for '${input.attachment.name}'.`),
      );
    }
    input.trackAttachmentPath?.(attachmentPath);

    yield* input.fileSystem
      .makeDirectory(input.path.dirname(attachmentPath), { recursive: true })
      .pipe(
        Effect.mapError(
          () => new Error(`Failed to create attachment directory for '${input.attachment.name}'.`),
        ),
      );
    yield* input.fileSystem
      .writeFile(attachmentPath, bytes)
      .pipe(
        Effect.mapError(
          () => new Error(`Failed to persist attachment '${input.attachment.name}'.`),
        ),
      );

    return persistedAttachment;
  });
}

function removePersistedAttachmentPaths(input: {
  readonly paths: ReadonlyArray<string>;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<void> {
  return Effect.forEach(
    input.paths,
    (attachmentPath) =>
      input.fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore),
    { discard: true, concurrency: 1 },
  );
}

export interface DispatchCommandNormalizerOptions<E> {
  readonly attachmentsDir: string;
  readonly chatWorkspaceRoot?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly canonicalizeProjectWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<string, E>;
  readonly prepareChatWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;
}

export function makeDispatchCommandNormalizer<E>(options: DispatchCommandNormalizerOptions<E>) {
  const maybePrepareChatWorkspaceRoot = (
    command: Extract<
      ClientOrchestrationCommand,
      { type: "project.create" | "project.meta.update" }
    >,
    workspaceRoot: string,
  ) => {
    if (
      command.kind !== "chat" ||
      command.createWorkspaceRootIfMissing !== true ||
      !options.chatWorkspaceRoot ||
      !options.prepareChatWorkspaceRoot ||
      !isWorkspaceRootWithin(workspaceRoot, options.chatWorkspaceRoot) ||
      workspaceRootsEqual(workspaceRoot, options.chatWorkspaceRoot)
    ) {
      return Effect.void;
    }
    return options.prepareChatWorkspaceRoot(workspaceRoot);
  };

  return Effect.fnUntraced(function* (input: { readonly command: ClientOrchestrationCommand }) {
    if (input.command.type === "project.create") {
      const workspaceRoot = yield* options.canonicalizeProjectWorkspaceRoot(
        input.command.workspaceRoot,
        {
          createIfMissing: input.command.createWorkspaceRootIfMissing === true,
        },
      );
      yield* maybePrepareChatWorkspaceRoot(input.command, workspaceRoot);
      return {
        ...input.command,
        workspaceRoot,
        createWorkspaceRootIfMissing: input.command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      const workspaceRoot = yield* options.canonicalizeProjectWorkspaceRoot(
        input.command.workspaceRoot,
        {
          createIfMissing: input.command.createWorkspaceRootIfMissing === true,
        },
      );
      yield* maybePrepareChatWorkspaceRoot(input.command, workspaceRoot);
      return {
        ...input.command,
        workspaceRoot,
        createWorkspaceRootIfMissing: input.command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const writtenAttachmentPaths: string[] = [];
    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type === "assistant-selection") {
            const attachmentId = createAttachmentId(turnStartCommand.threadId);
            if (!attachmentId) {
              return yield* Effect.fail(new Error("Failed to create a safe attachment id."));
            }

            return {
              type: "assistant-selection" as const,
              id: attachmentId,
              assistantMessageId: attachment.assistantMessageId,
              text: attachment.text,
            };
          }

          if (attachment.type === "image") {
            return yield* persistBinaryAttachment({
              attachment,
              threadId: turnStartCommand.threadId,
              attachmentsDir: options.attachmentsDir,
              fileSystem: options.fileSystem,
              path: options.path,
              maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
              requireImageMime: true,
              trackAttachmentPath: (attachmentPath) => writtenAttachmentPaths.push(attachmentPath),
            });
          }

          return yield* persistBinaryAttachment({
            attachment,
            threadId: turnStartCommand.threadId,
            attachmentsDir: options.attachmentsDir,
            fileSystem: options.fileSystem,
            path: options.path,
            maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
            requireImageMime: false,
            trackAttachmentPath: (attachmentPath) => writtenAttachmentPaths.push(attachmentPath),
          });
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* removePersistedAttachmentPaths({
            paths: writtenAttachmentPaths,
            fileSystem: options.fileSystem,
          });
          return yield* Effect.fail(error);
        }),
      ),
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
}
