// FILE: importedThreadMessages.test.ts
// Purpose: Verifies provider transcript snapshots become stable Synara import messages.
// Layer: Orchestration mapping tests
// Depends on: importedThreadMessages.

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  mapClaudeSessionMessages,
  mapCodexSnapshotMessages,
  mapFactorySnapshotMessages,
} from "./importedThreadMessages.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const importedAt = "2026-07-08T00:00:00.000Z";

function claudeMessage(
  uuid: string,
  type: SessionMessage["type"],
  message: unknown,
  timestamp?: string,
): SessionMessage & { readonly timestamp?: string } {
  return {
    uuid,
    type,
    message,
    session_id: "source-session",
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

describe("Codex transcript imports", () => {
  it("preserves item IDs and uses the original turn start and completion times", () => {
    const messages = mapCodexSnapshotMessages({
      threadId,
      importedAt,
      turns: [
        {
          id: "turn-original",
          startedAt: Date.parse("2026-07-07T10:00:00.000Z") / 1_000,
          completedAt: Date.parse("2026-07-07T10:00:05.000Z") / 1_000,
          items: [
            {
              id: "user-original",
              type: "userMessage",
              content: [{ type: "text", text: "Question" }],
            },
            { id: "assistant-original", type: "agentMessage", text: "Answer" },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      {
        messageId: "import:thread-1:codex:user-original",
        role: "user",
        text: "Question",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:00:00.000Z",
      },
      {
        messageId: "import:thread-1:codex:assistant-original",
        role: "assistant",
        text: "Answer",
        createdAt: "2026-07-07T10:00:05.000Z",
        updatedAt: "2026-07-07T10:00:05.000Z",
      },
    ]);
  });

  it("keeps native IDs stable when other rows are inserted and excludes tools and instructions", () => {
    const visibleItem = { id: "answer", type: "agentMessage", text: "  Kept verbatim.\n" };
    const hiddenItems = [
      { type: "commandExecution", text: "tool output" },
      { type: "hookPrompt", text: "injected instructions" },
      { type: "reasoning", text: "private reasoning" },
    ];
    const map = (items: ReadonlyArray<unknown>) =>
      mapCodexSnapshotMessages({ threadId, importedAt, turns: [{ items }] });
    expect(map([...hiddenItems, visibleItem])).toEqual(map([visibleItem]));
    expect(map([visibleItem])[0]?.text).toBe("  Kept verbatim.\n");
  });

  it("keeps timestamp-free transcripts ordered after the projection sorts by date and ID", () => {
    const messages = mapCodexSnapshotMessages({
      threadId,
      importedAt,
      turns: Array.from({ length: 12 }, (_, index) => ({
        items: [{ type: "agentMessage", id: `message-${12 - index}`, text: String(index) }],
      })),
    });
    const sorted = messages.toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.messageId.localeCompare(right.messageId),
    );
    expect(sorted.map((message) => message.text)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index)),
    );
    expect(messages[0]?.createdAt).toBe(importedAt);
    expect(messages[11]?.createdAt).toBe("2026-07-08T00:00:00.011Z");
  });

  it("uses enriched item timestamps before turn bounds and falls back for invalid dates", () => {
    expect(
      mapCodexSnapshotMessages({
        threadId,
        importedAt,
        turns: [
          {
            startedAt: "2026-07-07T10:00:00.000Z",
            completedAt: "invalid",
            items: [
              {
                type: "userMessage",
                text: "Question",
                createdAt: "invalid",
                timestamp: "2026-07-07T10:00:01.000Z",
              },
              {
                type: "agentMessage",
                text: "Answer",
                createdAt: Date.parse("2026-07-07T10:00:02.000Z"),
                updatedAt: "2026-07-07T10:00:03.000Z",
              },
            ],
          },
        ],
      }).map(({ createdAt, updatedAt }) => ({ createdAt, updatedAt })),
    ).toEqual([
      { createdAt: "2026-07-07T10:00:01.000Z", updatedAt: "2026-07-07T10:00:01.000Z" },
      { createdAt: "2026-07-07T10:00:02.000Z", updatedAt: "2026-07-07T10:00:03.000Z" },
    ]);
  });

  it("excludes native attachments and work rows from visible conversation text", () => {
    const turns = [
      {
        items: [
          {
            type: "userMessage",
            content: [
              { type: "text", text: "Question" },
              { type: "localImage", path: "/private/image.png" },
            ],
          },
          { type: "commandExecution", aggregatedOutput: "tool result" },
          { type: "agentMessage", text: "Answer" },
        ],
      },
    ];
    expect(
      mapCodexSnapshotMessages({ threadId, importedAt, turns }).map((message) => message.text),
    ).toEqual(["Question", "Answer"]);
  });
});

describe("Claude transcript imports", () => {
  it("preserves enriched source timestamps and UUIDs independent of SDK system row positions", () => {
    const source = claudeMessage(
      "answer",
      "assistant",
      { content: "  Answer\n" },
      "2026-07-07T12:00:00.000Z",
    );
    const map = (messages: ReadonlyArray<SessionMessage>) =>
      mapClaudeSessionMessages({ threadId, importedAt, messages });
    expect(
      map([claudeMessage("metadata", "system", { content: "system instructions" }), source]),
    ).toEqual(map([source]));
    expect(map([source])).toEqual([
      {
        messageId: "import:thread-1:claude:answer",
        role: "assistant",
        text: "  Answer\n",
        createdAt: "2026-07-07T12:00:00.000Z",
        updatedAt: "2026-07-07T12:00:00.000Z",
      },
    ]);
  });

  it("keeps source order through missing and repeated timestamps", () => {
    const messages = mapClaudeSessionMessages({
      threadId,
      importedAt,
      messages: [
        claudeMessage("z", "user", { content: "Undated question" }),
        claudeMessage("b", "assistant", { content: "Dated answer" }, "2026-07-07T12:00:00.000Z"),
        claudeMessage("a", "assistant", { content: "Same instant" }, "2026-07-07T12:00:00.000Z"),
        claudeMessage("c", "user", { content: "Invalid date" }, "invalid"),
      ],
    });
    expect(messages.map((message) => message.createdAt)).toEqual([
      "2026-07-07T11:59:59.999Z",
      "2026-07-07T12:00:00.000Z",
      "2026-07-07T12:00:00.001Z",
      "2026-07-07T12:00:00.002Z",
    ]);
  });

  it("does not turn tool results, thinking, or images into conversation text", () => {
    const messages = [
      claudeMessage("tools", "user", {
        content: [{ type: "tool_result", content: "secret tool output" }],
      }),
      claudeMessage("user", "user", {
        content: [
          { type: "text", text: "Question" },
          { type: "image", source: { data: "base64" } },
        ],
      }),
      claudeMessage("answer", "assistant", {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "tool_use", input: { command: "secret command" } },
          { type: "text", text: "Answer" },
        ],
      }),
    ];
    expect(
      mapClaudeSessionMessages({ threadId, importedAt, messages }).map((message) => message.text),
    ).toEqual(["Question", "Answer"]);
  });
});

it("maps visible Factory session items and ignores unrelated rows", () => {
  const importedAt = "2026-07-08T00:00:00.000Z";
  expect(
    mapFactorySnapshotMessages({
      threadId: ThreadId.makeUnsafe("thread-1"),
      importedAt,
      turns: [
        {
          items: [
            {
              type: "factoryMessage",
              id: "user-1",
              role: "user",
              text: "Question",
              timestamp: "2026-07-07T23:59:00.000Z",
            },
            { type: "tool", text: "hidden" },
          ],
        },
        {
          items: [{ type: "factoryMessage", id: "assistant-1", role: "assistant", text: "Answer" }],
        },
      ],
    }),
  ).toEqual([
    {
      messageId: "import:thread-1:droid:0:0:user-1",
      role: "user",
      text: "Question",
      createdAt: "2026-07-07T23:59:00.000Z",
      updatedAt: "2026-07-07T23:59:00.000Z",
    },
    {
      messageId: "import:thread-1:droid:1:0:assistant-1",
      role: "assistant",
      text: "Answer",
      createdAt: "2026-07-08T00:00:00.001Z",
      updatedAt: "2026-07-08T00:00:00.001Z",
    },
  ]);
});
