// Purpose: Build a Claude SDK user message (text + image attachments) from a provider send-turn input.
// Layer: standalone Effect helper; dependencies (FileSystem, attachments dir) passed explicitly.
// Exports: buildUserMessageEffect.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderSendTurnInput } from "@t3tools/contracts";
import { Effect, type FileSystem } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { PROVIDER, SUPPORTED_CLAUDE_IMAGE_MIME_TYPES } from "./ClaudeAdapter.config.ts";
import {
  buildClaudeImageContentBlock,
  buildPromptText,
  buildUserMessage,
  toMessage,
} from "./ClaudeAdapter.events.ts";

export function buildUserMessageEffect(
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
): Effect.Effect<SDKUserMessage, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const text = buildPromptText(input);
    const sdkContent: Array<Record<string, unknown>> = [];

    if (text.length > 0) {
      sdkContent.push({ type: "text", text });
    }

    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }

      if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
        });
      }

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: dependencies.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }

      const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: toMessage(cause, "Failed to read attachment file."),
              cause,
            }),
        ),
      );

      sdkContent.push(
        buildClaudeImageContentBlock({
          mimeType: attachment.mimeType,
          bytes,
        }),
      );
    }

    return buildUserMessage({ sdkContent });
  });
}
