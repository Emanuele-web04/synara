// FILE: promptAttachments.ts
// Purpose: Shared helpers for turning persisted chat attachments into provider-native prompt inputs.
// Layer: Provider adapter utilities
// Depends on: shared chat attachment contracts.

import type { ChatAttachment, ChatImageAttachment } from "@synara/contracts";

// Assistant selections stay in history as attachments, but the composer serializes them into text.
export function filterProviderPromptImageAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ChatImageAttachment[] {
  return (attachments ?? []).filter(
    (attachment): attachment is ChatImageAttachment => attachment.type === "image",
  );
}
