// FILE: subagentToolTrace.logic.test.ts
// Purpose: Locks the subagent tool-trace derivation to recent-N selection,
// overflow counting, and the settled-freeze (isLive) semantics.
// Layer: Web chat presentation tests
// Depends on: deriveSubagentToolTrace and deriveSubagentToolTraceByThreadId

import { EventId, ThreadId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../session-logic";
import type { Thread } from "../../types";
import {
  deriveSubagentToolTrace,
  deriveSubagentToolTraceByThreadId,
  SUBAGENT_TOOL_TRACE_MAX_ITEMS,
} from "./subagentToolTrace.logic";

function toolEntry(id: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id,
    createdAt: "2026-07-14T00:00:00.000Z",
    label: `Tool ${id}`,
    tone: "tool",
    ...overrides,
  };
}

function toolActivity(id: string, summary: string): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    createdAt: "2026-07-14T00:00:01.000Z",
    kind: "tool.completed",
    summary,
    tone: "tool",
    payload: {},
    turnId: null,
  };
}

function childThread(id: string, activities: OrchestrationThreadActivity[]): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    title: "Subagent task",
    modelSelection: { provider: "claudeAgent", model: "sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-07-14T00:00:01.000Z",
    latestTurn: null,
    parentThreadId: ThreadId.makeUnsafe("thread-main"),
    turnDiffSummaries: [],
    activities,
    branch: null,
    worktreePath: null,
  };
}

describe("deriveSubagentToolTrace", () => {
  it("returns null when the child produced no tool calls yet", () => {
    expect(deriveSubagentToolTrace([], true)).toBeNull();
    expect(deriveSubagentToolTrace([toolEntry("info-1", { tone: "info" })], true)).toBeNull();
  });

  it("keeps the most recent tool calls in order without overflow", () => {
    const trace = deriveSubagentToolTrace([toolEntry("t1"), toolEntry("t2")], true);
    expect(trace?.entries.map((entry) => entry.id)).toEqual(["t1", "t2"]);
    expect(trace?.overflowCount).toBe(0);
  });

  it("caps at the recency limit and counts the hidden earlier tool uses", () => {
    const entries = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => toolEntry(id));
    const trace = deriveSubagentToolTrace(entries, true);
    expect(trace?.entries.map((entry) => entry.id)).toEqual(["t3", "t4", "t5", "t6"]);
    expect(trace?.entries).toHaveLength(SUBAGENT_TOOL_TRACE_MAX_ITEMS);
    expect(trace?.overflowCount).toBe(2);
  });

  it("skips reasoning traces and status-only rows", () => {
    const trace = deriveSubagentToolTrace(
      [
        toolEntry("reasoning", { toolTitle: "Reasoning" }),
        toolEntry("status-only", { itemType: "command_execution" }),
        toolEntry("t1", { command: "ls" }),
      ],
      true,
    );
    expect(trace?.entries.map((entry) => entry.id)).toEqual(["t1"]);
    expect(trace?.overflowCount).toBe(0);
  });

  it("freezes settled subagents by marking the trace not live", () => {
    const entries = [toolEntry("t1")];
    const live = deriveSubagentToolTrace(entries, true);
    const settled = deriveSubagentToolTrace(entries, false);
    expect(live?.isLive).toBe(true);
    expect(settled?.isLive).toBe(false);
    expect(settled?.entries).toEqual(live?.entries);
  });
});

function subagent(overrides: Partial<NonNullable<WorkLogEntry["subagents"]>[number]>) {
  return {
    threadId: "toolu_x",
    providerThreadId: "toolu_x",
    ...overrides,
  };
}

describe("deriveSubagentToolTraceByThreadId", () => {
  it("keys traces by the resolved child thread id from stored activities", () => {
    const thread = childThread("subagent:thread-main:toolu_x", [
      toolActivity("a1", "Read ChatView.tsx"),
      toolActivity("a2", "Bash grep"),
    ]);
    const traceByThreadId = deriveSubagentToolTraceByThreadId({
      workEntries: [
        toolEntry("entry-1", {
          itemType: "collab_agent_tool_call",
          subagents: [subagent({ resolvedThreadId: thread.id, isActive: true })],
        }),
      ],
      threads: [thread],
    });

    const trace = traceByThreadId.get(thread.id);
    expect(trace?.entries.map((entry) => entry.label)).toEqual(["Read ChatView.tsx", "Bash grep"]);
    expect(trace?.isLive).toBe(true);
  });

  it("omits subagents without a resolved thread or stored activities", () => {
    const traceByThreadId = deriveSubagentToolTraceByThreadId({
      workEntries: [
        toolEntry("entry-1", {
          itemType: "collab_agent_tool_call",
          subagents: [
            subagent({}),
            subagent({ threadId: "toolu_y", resolvedThreadId: "subagent:thread-main:toolu_y" }),
          ],
        }),
      ],
      threads: [childThread("subagent:thread-main:toolu_y", [])],
    });
    expect(traceByThreadId.size).toBe(0);
  });

  it("takes the freshest liveness when later snapshots settle the subagent", () => {
    const thread = childThread("subagent:thread-main:toolu_x", [toolActivity("a1", "Read file")]);
    const traceByThreadId = deriveSubagentToolTraceByThreadId({
      workEntries: [
        toolEntry("entry-1", {
          itemType: "collab_agent_tool_call",
          subagents: [subagent({ resolvedThreadId: thread.id, isActive: true })],
        }),
        toolEntry("entry-2", {
          itemType: "collab_agent_tool_call",
          subagents: [subagent({ resolvedThreadId: thread.id })],
        }),
      ],
      threads: [thread],
    });
    expect(traceByThreadId.get(thread.id)?.isLive).toBe(false);
  });
});
