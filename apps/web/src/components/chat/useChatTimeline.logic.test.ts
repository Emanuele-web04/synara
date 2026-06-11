import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { deriveTimelineMessages } from "./useChatTimeline.logic";

function message(overrides: Omit<Partial<ChatMessage>, "id"> & { id: string }): ChatMessage {
  const { id, ...messageOverrides } = overrides;
  return {
    id: MessageId.makeUnsafe(id),
    role: "user",
    text: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    streaming: false,
    ...messageOverrides,
  };
}

describe("deriveTimelineMessages", () => {
  it("returns the original message array for the common unchanged transcript path", () => {
    const messages = [message({ id: "user" }), message({ id: "assistant", role: "assistant" })];

    const result = deriveTimelineMessages({
      serverMessages: messages,
      isSidechat: false,
      attachmentPreviewHandoffByMessageId: {},
      optimisticUserMessages: [],
    });

    expect(result).toBe(messages);
  });

  it("returns the original sidechat message array when there is no imported fork history", () => {
    const messages = [message({ id: "native", source: "native" })];

    const result = deriveTimelineMessages({
      serverMessages: messages,
      isSidechat: true,
      attachmentPreviewHandoffByMessageId: {},
      optimisticUserMessages: [],
    });

    expect(result).toBe(messages);
  });

  it("filters imported fork history from sidechat transcripts", () => {
    const imported = message({ id: "imported", source: "fork-import" });
    const native = message({ id: "native", source: "native" });

    expect(
      deriveTimelineMessages({
        serverMessages: [imported, native],
        isSidechat: true,
        attachmentPreviewHandoffByMessageId: {},
        optimisticUserMessages: [],
      }),
    ).toEqual([native]);
  });

  it("applies image preview handoff while preserving unchanged message references", () => {
    const assistant = message({ id: "assistant", role: "assistant" });
    const user = message({
      id: "user",
      attachments: [
        {
          type: "image",
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 10,
          previewUrl: "blob:old",
        },
      ],
    });

    const result = deriveTimelineMessages({
      serverMessages: [assistant, user],
      isSidechat: false,
      attachmentPreviewHandoffByMessageId: { user: ["blob:new"] },
      optimisticUserMessages: [],
    });

    expect(result[0]).toBe(assistant);
    expect(result[1]).not.toBe(user);
    expect(result[1]?.attachments?.[0]).toMatchObject({ previewUrl: "blob:new" });
  });

  it("keeps the original message array when preview handoff does not change any attachment", () => {
    const user = message({
      id: "user",
      attachments: [
        {
          type: "image",
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 10,
          previewUrl: "blob:same",
        },
      ],
    });
    const messages = [user];

    const result = deriveTimelineMessages({
      serverMessages: messages,
      isSidechat: false,
      attachmentPreviewHandoffByMessageId: { user: ["blob:same"] },
      optimisticUserMessages: [],
    });

    expect(result).toBe(messages);
    expect(result[0]).toBe(user);
  });

  it("appends optimistic messages that have not been echoed by the server", () => {
    const echoed = message({ id: "echoed" });
    const pending = message({ id: "pending" });

    const result = deriveTimelineMessages({
      serverMessages: [echoed],
      isSidechat: false,
      attachmentPreviewHandoffByMessageId: {},
      optimisticUserMessages: [echoed, pending],
    });

    expect(result.map((entry) => entry.id)).toEqual([
      MessageId.makeUnsafe("echoed"),
      MessageId.makeUnsafe("pending"),
    ]);
  });

  it("returns the original server array when a single optimistic message was already echoed", () => {
    const echoed = message({ id: "echoed" });
    const messages = [echoed];

    const result = deriveTimelineMessages({
      serverMessages: messages,
      isSidechat: false,
      attachmentPreviewHandoffByMessageId: {},
      optimisticUserMessages: [echoed],
    });

    expect(result).toBe(messages);
  });
});
