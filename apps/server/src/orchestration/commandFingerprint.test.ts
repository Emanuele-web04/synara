import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { fingerprintOrchestrationCommand } from "./commandFingerprint";

function turnCommand(overrides: Partial<OrchestrationCommand> = {}): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("command-a"),
    threadId: ThreadId.makeUnsafe("thread-a"),
    message: {
      messageId: MessageId.makeUnsafe("message-a"),
      role: "user",
      text: "hello",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  } as OrchestrationCommand;
}

describe("fingerprintOrchestrationCommand", () => {
  it("ignores generated assistant-selection ids and untrusted upload metadata", () => {
    const withAttachments = (assistantId: string, uploadName: string) =>
      turnCommand({
        message: {
          messageId: MessageId.makeUnsafe("message-a"),
          role: "user",
          text: "hello",
          attachments: [
            {
              type: "assistant-selection",
              id: assistantId,
              assistantMessageId: MessageId.makeUnsafe("assistant-a"),
              text: "selection",
            },
            {
              type: "image",
              id: "att_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              name: uploadName,
              mimeType: "image/png",
              sizeBytes: uploadName.length,
            },
          ],
        },
      });

    expect(fingerprintOrchestrationCommand(withAttachments("generated-a", "one.png"))).toEqual(
      fingerprintOrchestrationCommand(withAttachments("generated-b", "spoofed.png")),
    );
  });
});
