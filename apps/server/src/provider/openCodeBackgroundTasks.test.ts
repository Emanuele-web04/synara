import { describe, expect, it } from "vitest";

import {
  detectOpenCodeBackgroundTaskSettlement,
  detectOpenCodeBackgroundTaskStart,
  type OpenCodeToolPart,
} from "./openCodeBackgroundTasks.ts";

function makeToolPart(input: {
  readonly tool: string;
  readonly status?: string;
  readonly output?: string;
  readonly metadata?: Record<string, unknown>;
  readonly partMetadata?: Record<string, unknown>;
  readonly title?: string;
  readonly toolInput?: Record<string, unknown>;
}): OpenCodeToolPart {
  return {
    id: "part-1",
    messageID: "message-1",
    sessionID: "opencode-session-1",
    type: "tool",
    tool: input.tool,
    callID: "call-1",
    ...(input.partMetadata ? { metadata: input.partMetadata } : {}),
    state: {
      status: input.status ?? "completed",
      output: input.output ?? "",
      title: input.title,
      input: input.toolInput ?? {},
      metadata: input.metadata,
      time: { start: 1, end: 2 },
    },
  } as unknown as OpenCodeToolPart;
}

describe("detectOpenCodeBackgroundTaskStart", () => {
  it("detects a native background task tool call", () => {
    const part = makeToolPart({
      tool: "task",
      metadata: {
        parentSessionId: "opencode-session-1",
        sessionId: "child-session-1",
        model: "openai/gpt-5.4",
        background: true,
        jobId: "child-session-1",
      },
      title: "Explore the codebase",
      toolInput: {
        description: "Explore the codebase",
        prompt: "Find where sessions are stored",
        subagent_type: "explore",
      },
      output:
        '<task id="child-session-1" state="running"><summary>Background task started</summary></task>',
    });

    expect(detectOpenCodeBackgroundTaskStart(part)).toEqual({
      taskId: "child-session-1",
      childSessionId: "child-session-1",
      description: "Explore the codebase",
      subagentType: "explore",
      source: "native-task",
    });
  });

  it("still detects the native 'updated' result for the same running task", () => {
    const part = makeToolPart({
      tool: "Task",
      metadata: { sessionId: "child-session-1", background: true, jobId: "child-session-1" },
      toolInput: { description: "Check on it" },
      output:
        '<task id="child-session-1" state="running"><summary>Background task updated</summary></task>',
    });

    expect(detectOpenCodeBackgroundTaskStart(part)).toMatchObject({
      taskId: "child-session-1",
      childSessionId: "child-session-1",
      source: "native-task",
    });
  });

  it("ignores a task tool call that is not backgrounded", () => {
    const part = makeToolPart({
      tool: "task",
      metadata: { sessionId: "child-session-1", background: false },
      toolInput: { description: "foreground" },
    });
    expect(detectOpenCodeBackgroundTaskStart(part)).toBeNull();
  });

  it("ignores a task tool call that is still running", () => {
    const part = makeToolPart({
      tool: "task",
      status: "running",
      metadata: { sessionId: "child-session-1", background: true },
    });
    expect(detectOpenCodeBackgroundTaskStart(part)).toBeNull();
  });

  it("detects a delegate plugin background start", () => {
    const part = makeToolPart({
      tool: "delegate",
      output: "Delegation started: delegation-abc-123",
      toolInput: {
        agent: "researcher",
        prompt: "Summarize the release notes\nInclude breaking changes",
      },
    });

    expect(detectOpenCodeBackgroundTaskStart(part)).toEqual({
      taskId: "delegation-abc-123",
      childSessionId: null,
      description: "Summarize the release notes",
      subagentType: "researcher",
      source: "delegate-plugin",
    });
  });

  it("detects a v2 subagent tool returning a running child", () => {
    expect(
      detectOpenCodeBackgroundTaskStart(
        makeToolPart({
          tool: "subagent",
          metadata: { sessionID: "v2-child", status: "running" },
          toolInput: { description: "Explore the runtime", agent: "explore", background: true },
        }),
      ),
    ).toEqual({
      taskId: "v2-child",
      childSessionId: "v2-child",
      description: "Explore the runtime",
      subagentType: "explore",
      source: "native-task",
    });
  });

  it("detects a foreground v2 subagent that was moved into the background", () => {
    expect(
      detectOpenCodeBackgroundTaskStart(
        makeToolPart({
          tool: "subagent",
          metadata: { sessionID: "v2-child", status: "running" },
          toolInput: { agent: "explore" },
        }),
      ),
    ).toMatchObject({ taskId: "v2-child", childSessionId: "v2-child" });
  });

  it("ignores completed, still executing, or unowned v2 subagent results", () => {
    for (const part of [
      makeToolPart({ tool: "subagent", metadata: { sessionID: "v2-child", status: "completed" } }),
      makeToolPart({
        tool: "subagent",
        status: "running",
        metadata: { sessionID: "v2-child", status: "running" },
      }),
      makeToolPart({ tool: "subagent", metadata: { status: "running" } }),
    ])
      expect(detectOpenCodeBackgroundTaskStart(part)).toBeNull();
  });
});

describe("detectOpenCodeBackgroundTaskSettlement", () => {
  it("detects a native completed settlement", () => {
    expect(
      detectOpenCodeBackgroundTaskSettlement(
        '<task id="child-session-1" state="completed"><summary>Background task completed: Explore the codebase</summary><task_result>done</task_result></task>',
      ),
    ).toEqual({
      taskId: "child-session-1",
      status: "completed",
      summary: "Background task completed: Explore the codebase",
    });
  });

  it("detects a native error settlement", () => {
    expect(
      detectOpenCodeBackgroundTaskSettlement(
        '<task id="child-session-1" state="error"><summary>Background task failed</summary><task_error>boom</task_error></task>',
      ),
    ).toEqual({
      taskId: "child-session-1",
      status: "failed",
      summary: "Background task failed",
    });
  });

  it("detects a plugin task-notification as completed", () => {
    expect(
      detectOpenCodeBackgroundTaskSettlement(
        "<task-notification>Delegation id: delegation-abc-123 completed successfully.</task-notification>",
      ),
    ).toEqual({
      taskId: "delegation-abc-123",
      status: "completed",
      summary: undefined,
    });
  });

  it("detects a plugin task-notification as failed", () => {
    expect(
      detectOpenCodeBackgroundTaskSettlement(
        "<task-notification>delegation_id=delegation-abc-123 failed with an error.</task-notification>",
      ),
    ).toEqual({
      taskId: "delegation-abc-123",
      status: "failed",
      summary: undefined,
    });
  });

  it("returns null for unrelated text", () => {
    expect(detectOpenCodeBackgroundTaskSettlement("The agent finished its work.")).toBeNull();
    expect(detectOpenCodeBackgroundTaskSettlement("<task>no attributes</task>")).toBeNull();
  });
});
