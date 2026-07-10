// FILE: promptAttachments.test.ts
// Purpose: Locks provider prompt attachment filtering so UI-only context chips do not reach native providers.
// Layer: Provider adapter utility tests
// Depends on: promptAttachments helper and shared chat attachment contracts.

import { MessageId, type ChatAttachment } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { filterProviderPromptImageAttachments } from "./promptAttachments.ts";

describe("filterProviderPromptImageAttachments", () => {
  it("keeps images while dropping assistant selections from provider-native prompts", () => {
    const imageAttachment = {
      type: "image",
      id: "thread-1-image-1",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 128,
    } satisfies ChatAttachment;
    const selectionAttachment = {
      type: "assistant-selection",
      id: "thread-1-selection-1",
      assistantMessageId: MessageId.makeUnsafe("assistant-message-1"),
      text: "Selected assistant text is already serialized into the prompt body.",
    } satisfies ChatAttachment;

    expect(filterProviderPromptImageAttachments([selectionAttachment, imageAttachment])).toEqual([
      imageAttachment,
    ]);
  });
});
