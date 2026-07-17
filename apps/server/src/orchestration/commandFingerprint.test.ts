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
  it("ignores the idempotency key but changes when authoritative intent changes", () => {
    const first = fingerprintOrchestrationCommand(turnCommand());
    const sameIntent = fingerprintOrchestrationCommand(
      turnCommand({ commandId: CommandId.makeUnsafe("command-b") }),
    );
    const changedIntent = fingerprintOrchestrationCommand(
      turnCommand({ createdAt: "2026-07-14T00:00:01.000Z" }),
    );

    expect(sameIntent).toEqual(first);
    expect(changedIntent.value).not.toBe(first.value);
  });

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

  it("ignores only server-assigned timestamps for Companion request IDs", () => {
    const first = fingerprintOrchestrationCommand(
      turnCommand({
        commandId: CommandId.makeUnsafe(
          "companion:turn:11111111-1111-4111-8111-111111111111",
        ),
      }),
    );
    const retried = fingerprintOrchestrationCommand(
      turnCommand({
        commandId: CommandId.makeUnsafe(
          "companion:turn:11111111-1111-4111-8111-111111111111",
        ),
        createdAt: "2026-07-14T00:01:00.000Z",
      }),
    );
    const changedText = fingerprintOrchestrationCommand(
      turnCommand({
        commandId: CommandId.makeUnsafe(
          "companion:turn:11111111-1111-4111-8111-111111111111",
        ),
        createdAt: "2026-07-14T00:01:00.000Z",
        message: {
          messageId: MessageId.makeUnsafe(
            "companion:message:11111111-1111-4111-8111-111111111111",
          ),
          role: "user",
          text: "changed",
          attachments: [],
        },
      }),
    );

    expect(retried).toEqual(first);
    expect(changedText.value).not.toBe(first.value);
  });
});
