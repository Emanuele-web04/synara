// FILE: promptAttachments.ts
// Purpose: Shared helpers for turning persisted chat attachments into provider-native prompt inputs.
// Layer: Provider adapter utilities
// Depends on: shared chat attachment contracts.

import type { ChatAttachment, ChatImageAttachment, ProviderKind } from "@synara/contracts";
import { Effect } from "effect";

import { resolveProviderAttachmentPath } from "./providerAttachmentPaths.ts";
import { ProviderAdapterRequestError } from "./Errors.ts";

// Assistant selections stay in history as attachments, but the composer serializes them into text.
export function filterProviderPromptImageAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ChatImageAttachment[] {
  return (attachments ?? []).filter(
    (attachment): attachment is ChatImageAttachment => attachment.type === "image",
  );
}

export interface ProviderPromptImageBlock {
  readonly type: "image";
  readonly mimeType: string;
  readonly data: string;
}

export function loadProviderPromptImageBlocks(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly provider: ProviderKind;
  readonly method: string;
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, unknown>;
  readonly readErrorDetail?: (cause: unknown) => string;
}): Effect.Effect<ProviderPromptImageBlock[], ProviderAdapterRequestError> {
  return Effect.forEach(filterProviderPromptImageAttachments(input.attachments), (attachment) => {
    const attachmentPath = resolveProviderAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: input.provider,
          method: input.method,
          detail: `Invalid attachment id '${attachment.id}'.`,
        }),
      );
    }
    return input.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: input.provider,
            method: input.method,
            detail:
              input.readErrorDetail?.(cause) ??
              (cause instanceof Error ? cause.message : String(cause)),
            cause,
          }),
      ),
      Effect.map((bytes) => ({
        type: "image" as const,
        mimeType: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      })),
    );
  });
}
