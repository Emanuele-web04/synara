import { MessageId, type OrchestrationReadModel } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ChatAttachment } from "../types";
import { normalizeChatAttachments, readModelAttachmentsFromChatMessage } from "./threadMessages";

type ReadModelAttachment = NonNullable<
  OrchestrationReadModel["threads"][number]["messages"][number]["attachments"]
>[number];

describe("thread message attachment normalization", () => {
  it("preserves persisted file attachments as files, not image previews", () => {
    const attachments: ReadModelAttachment[] = [
      {
        type: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
    ];

    expect(normalizeChatAttachments(attachments, undefined)).toEqual([
      {
        type: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
    ]);
  });

  it("round-trips file, image, and assistant-selection attachments with their original kinds", () => {
    const attachments: ChatAttachment[] = [
      {
        type: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
      {
        type: "image",
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 100,
        previewUrl: "blob:diagram",
      },
      {
        type: "assistant-selection",
        id: "selection-1",
        assistantMessageId: "assistant-1",
        text: "selected text",
      },
    ];

    expect(readModelAttachmentsFromChatMessage(attachments)).toEqual([
      {
        type: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
      {
        type: "image",
        id: "image-1",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
      {
        type: "assistant-selection",
        id: "selection-1",
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        text: "selected text",
      },
    ]);
  });
});
