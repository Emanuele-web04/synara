// FILE: importedThreadMessages.test.ts
// Purpose: Verifies provider transcript snapshots become stable Synara import messages.
// Layer: Orchestration mapping tests
// Depends on: importedThreadMessages.

import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  mapClaudeSessionTranscript,
  mapCodexSnapshotTranscript,
  mapFactorySnapshotMessages,
} from "./importedThreadMessages.ts";

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

function claudeRecord(input: {
  type: "user" | "assistant";
  uuid: string;
  content: unknown;
  timestamp?: string;
  parentToolUseId?: string | null;
  parentAgentId?: string | null;
}): ClaudeSessionMessage {
  return {
    type: input.type,
    uuid: input.uuid,
    session_id: "session-1",
    message: { role: input.type, content: input.content },
    parent_tool_use_id: input.parentToolUseId ?? null,
    parent_agent_id: input.parentAgentId ?? null,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  } as ClaudeSessionMessage;
}

describe("mapClaudeSessionTranscript", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const importedAt = "2026-08-07T00:00:00.000Z";

  it("maps text, thinking, and tool lifecycles with real timestamps", () => {
    const transcript = mapClaudeSessionTranscript({
      threadId,
      importedAt,
      messages: [
        claudeRecord({
          type: "user",
          uuid: "u-1",
          content: "Fix the bug",
          timestamp: "2026-08-01T09:00:00.000Z",
        }),
        claudeRecord({
          type: "assistant",
          uuid: "a-1",
          timestamp: "2026-08-01T09:00:05.000Z",
          content: [
            { type: "thinking", thinking: "Let me look at the file first." },
            { type: "text", text: "Looking into it." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "bun test" },
            },
          ],
        }),
        claudeRecord({
          type: "user",
          uuid: "u-2",
          timestamp: "2026-08-01T09:00:20.000Z",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "all tests passed",
            },
          ],
        }),
      ],
    });

    expect(transcript.messages).toEqual([
      {
        messageId: "import:thread-1:claude:u-1",
        role: "user",
        text: "Fix the bug",
        createdAt: "2026-08-01T09:00:00.000Z",
        updatedAt: "2026-08-01T09:00:00.000Z",
      },
      {
        messageId: "import:thread-1:claude:a-1",
        role: "assistant",
        text: "Looking into it.",
        createdAt: "2026-08-01T09:00:05.000Z",
        updatedAt: "2026-08-01T09:00:05.000Z",
      },
    ]);

    expect(transcript.activities).toHaveLength(2);
    const [reasoning, tool] = transcript.activities;
    expect(reasoning?.id).toBe("import:thread-1:claude:reasoning:a-1:0");
    expect(reasoning?.kind).toBe("task.progress");
    expect(reasoning?.summary).toBe("Reasoning trace");
    expect(reasoning?.createdAt).toBe("2026-08-01T09:00:05.000Z");
    expect(reasoning?.payload).toMatchObject({
      detail: "Let me look at the file first.",
    });

    expect(tool?.id).toBe("import:thread-1:claude:tool:tool-1");
    expect(tool?.kind).toBe("tool.completed");
    expect(tool?.tone).toBe("tool");
    expect(tool?.createdAt).toBe("2026-08-01T09:00:20.000Z");
    expect(tool?.payload).toMatchObject({
      itemType: "command_execution",
      status: "completed",
      title: "Command run",
      data: {
        toolCallId: "tool-1",
        callId: "tool-1",
        toolName: "Bash",
        input: { command: "bun test" },
        result: "all tests passed",
      },
    });
    expect(tool?.sequence).toBe(1);
  });

  it("marks failed tool results and leaves unmatched tools as started", () => {
    const transcript = mapClaudeSessionTranscript({
      threadId,
      importedAt,
      messages: [
        claudeRecord({
          type: "assistant",
          uuid: "a-1",
          timestamp: "2026-08-01T09:00:00.000Z",
          content: [
            { type: "tool_use", id: "tool-fail", name: "Bash", input: { command: "exit 1" } },
            { type: "tool_use", id: "tool-hang", name: "Edit", input: { file_path: "/tmp/x" } },
          ],
        }),
        claudeRecord({
          type: "user",
          uuid: "u-1",
          timestamp: "2026-08-01T09:00:10.000Z",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-fail",
              content: "command failed",
              is_error: true,
            },
          ],
        }),
      ],
    });

    expect(transcript.activities).toHaveLength(2);
    const failed = transcript.activities.find(
      (activity) => activity.id === "import:thread-1:claude:tool:tool-fail",
    );
    expect(failed?.kind).toBe("tool.completed");
    expect(failed?.payload).toMatchObject({ status: "failed" });

    const hanging = transcript.activities.find(
      (activity) => activity.id === "import:thread-1:claude:tool:tool-hang",
    );
    expect(hanging?.kind).toBe("tool.started");
    expect(hanging?.summary).toBe("File change started");
    expect(hanging?.createdAt).toBe("2026-08-01T09:00:00.000Z");
    expect(hanging?.payload).toMatchObject({ status: "inProgress" });
  });

  it("skips client-surfaced tools, subagent records, and plan tools", () => {
    const transcript = mapClaudeSessionTranscript({
      threadId,
      importedAt,
      messages: [
        claudeRecord({
          type: "assistant",
          uuid: "a-1",
          content: [
            { type: "tool_use", id: "tool-ask", name: "AskUserQuestion", input: {} },
            { type: "tool_use", id: "tool-plan", name: "TodoWrite", input: { todos: [] } },
            { type: "text", text: "Main answer" },
          ],
        }),
        claudeRecord({
          type: "assistant",
          uuid: "a-side",
          content: [{ type: "text", text: "Subagent text" }],
          parentAgentId: "agent-1",
        }),
        claudeRecord({
          type: "user",
          uuid: "u-side",
          content: "Subagent tool text",
          parentToolUseId: "tool-parent",
        }),
        claudeRecord({
          type: "user",
          uuid: "u-1",
          content: [
            { type: "tool_result", tool_use_id: "tool-ask", content: "answered" },
            { type: "tool_result", tool_use_id: "tool-plan", content: "ok" },
          ],
        }),
      ],
    });

    expect(transcript.messages.map((message) => message.messageId)).toEqual([
      "import:thread-1:claude:a-1",
    ]);
    expect(transcript.activities).toEqual([]);
  });

  it("falls back to monotonically increasing import timestamps when records carry none", () => {
    const transcript = mapClaudeSessionTranscript({
      threadId,
      importedAt,
      messages: [
        claudeRecord({ type: "user", uuid: "u-1", content: "First" }),
        claudeRecord({
          type: "assistant",
          uuid: "a-1",
          content: [{ type: "text", text: "Second" }],
        }),
      ],
    });

    expect(transcript.messages[0]?.createdAt).toBe("2026-08-07T00:00:00.000Z");
    expect(transcript.messages[1]?.createdAt).toBe("2026-08-07T00:00:00.001Z");
  });
});

describe("mapCodexSnapshotTranscript", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const importedAt = "2026-08-07T00:00:00.000Z";

  it("maps messages and turns tool and reasoning items into activities", () => {
    const transcript = mapCodexSnapshotTranscript({
      threadId,
      importedAt,
      turns: [
        {
          items: [
            { type: "userMessage", text: "Run the build" },
            { type: "reasoning", summary: "Considering build steps" },
            {
              type: "commandExecution",
              command: "bun run build",
              timestamp: "2026-08-01T12:00:00.000Z",
            },
            { type: "agentMessage", text: "Build finished" },
          ],
        },
      ],
    });

    expect(transcript.messages.map((message) => message.text)).toEqual([
      "Run the build",
      "Build finished",
    ]);

    expect(transcript.activities).toHaveLength(2);
    const [reasoning, command] = transcript.activities;
    expect(reasoning?.kind).toBe("task.progress");
    expect(reasoning?.summary).toBe("Reasoning trace");
    expect(reasoning?.payload).toMatchObject({ detail: "Considering build steps" });

    expect(command?.id).toBe("import:thread-1:codex:activity:0:2");
    expect(command?.kind).toBe("tool.completed");
    expect(command?.createdAt).toBe("2026-08-01T12:00:00.000Z");
    expect(command?.payload).toMatchObject({
      itemType: "command_execution",
      status: "completed",
      title: "Ran command",
      detail: "bun run build",
    });
  });
});
