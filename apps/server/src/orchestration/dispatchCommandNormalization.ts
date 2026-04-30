import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import type { FileSystem, Path } from "effect";
import { Effect } from "effect";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore";
import { parseBase64DataUrl } from "../imageMime";

export interface DispatchCommandNormalizerOptions<E> {
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly canonicalizeProjectWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<string, E>;
}

export function makeDispatchCommandNormalizer<E>(options: DispatchCommandNormalizerOptions<E>) {
  return Effect.fnUntraced(function* (input: { readonly command: ClientOrchestrationCommand }) {
    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* options.canonicalizeProjectWorkspaceRoot(
          input.command.workspaceRoot,
          {
            createIfMissing: input.command.createWorkspaceRootIfMissing === true,
          },
        ),
        createWorkspaceRootIfMissing: input.command.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      return {
        ...input.command,
        workspaceRoot: yield* options.canonicalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

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

          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* Effect.fail(
              new Error(`Invalid image attachment payload for '${attachment.name}'.`),
            );
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* Effect.fail(
              new Error(`Image attachment '${attachment.name}' is empty or too large.`),
            );
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* Effect.fail(new Error("Failed to create a safe attachment id."));
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: options.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* Effect.fail(
              new Error(`Failed to resolve persisted path for '${attachment.name}'.`),
            );
          }

          yield* options.fileSystem
            .makeDirectory(options.path.dirname(attachmentPath), { recursive: true })
            .pipe(
              Effect.mapError(
                () => new Error(`Failed to create attachment directory for '${attachment.name}'.`),
              ),
            );
          yield* options.fileSystem
            .writeFile(attachmentPath, bytes)
            .pipe(
              Effect.mapError(
                () => new Error(`Failed to persist attachment '${attachment.name}'.`),
              ),
            );

          return persistedAttachment;
        }),
      { concurrency: 1 },
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
