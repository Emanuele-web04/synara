// FILE: WorkflowRunCard.logic.test.ts
// Purpose: Locks workflow run panel derivation to task-activity folding: workflow
// identity, member tagging, status/usage snapshots, thread linking, and retiring
// once the workflow run settles.
// Layer: Web chat composer tests
// Depends on: deriveWorkflowRunState

import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deriveWorkflowRunState, workflowElapsedMs } from "./WorkflowRunCard.logic";

function activity(overrides: {
  id: string;
  createdAt: string;
  kind: string;
  payload: OrchestrationThreadActivity["payload"];
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id),
    createdAt: overrides.createdAt,
    kind: overrides.kind,
    summary: "Task activity",
    tone: "info",
    payload: overrides.payload,
    turnId: null,
  };
}

function workflowStarted(overrides?: {
  id?: string;
  taskId?: string;
}): OrchestrationThreadActivity {
  return activity({
    id: overrides?.id ?? "workflow-started",
    createdAt: "2026-07-14T00:00:00.000Z",
    kind: "task.started",
    payload: {
      taskId: overrides?.taskId ?? "wf-1",
      taskType: "local_workflow",
      workflowName: "spec",
      detail: "Draft the feature spec",
    },
  });
}

function agentStarted(overrides?: {
  taskId?: string;
  toolUseId?: string;
  workflowTaskId?: string | null;
}): OrchestrationThreadActivity {
  return activity({
    id: `${overrides?.taskId ?? "agent-1"}-started`,
    createdAt: "2026-07-14T00:00:05.000Z",
    kind: "task.started",
    payload: {
      taskId: overrides?.taskId ?? "agent-1",
      subagentType: "researcher",
      detail: "Research prior art",
      ...(overrides?.workflowTaskId === null
        ? {}
        : { workflowTaskId: overrides?.workflowTaskId ?? "wf-1" }),
      ...(overrides?.toolUseId ? { toolUseId: overrides.toolUseId } : {}),
    },
  });
}

describe("deriveWorkflowRunState", () => {
  it("returns null without a live workflow task", () => {
    expect(deriveWorkflowRunState({ activities: [agentStarted()] })).toBeNull();
  });

  it("derives the workflow header and one row per tagged member agent", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted(),
        agentStarted(),
        agentStarted({ taskId: "agent-untagged", workflowTaskId: null }),
        activity({
          id: "agent-1-progress",
          createdAt: "2026-07-14T00:00:10.000Z",
          kind: "task.progress",
          payload: {
            taskId: "agent-1",
            workflowTaskId: "wf-1",
            usage: { total_tokens: 321, tool_uses: 2, duration_ms: 4_500 },
          },
        }),
      ],
    });

    expect(state).not.toBeNull();
    expect(state?.workflowTaskId).toBe("wf-1");
    expect(state?.name).toBe("spec");
    expect(state?.description).toBe("Draft the feature spec");
    expect(state?.runningCount).toBe(1);
    expect(state?.taskIds).toEqual(["wf-1", "agent-1"]);
    expect(state?.agents).toEqual([
      expect.objectContaining({
        taskId: "agent-1",
        description: "Research prior art",
        subagentType: "researcher",
        phase: null,
        statusKind: "running",
        statusLabel: "Running",
        totalTokens: 321,
        durationMs: 4_500,
        threadId: null,
        modelLabel: undefined,
      }),
    ]);
  });

  it("tracks status transitions from task.updated and task.completed", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted(),
        agentStarted(),
        agentStarted({ taskId: "agent-2" }),
        agentStarted({ taskId: "agent-3" }),
        activity({
          id: "agent-1-paused",
          createdAt: "2026-07-14T00:00:10.000Z",
          kind: "task.updated",
          payload: { taskId: "agent-1", status: "paused", workflowTaskId: "wf-1" },
        }),
        activity({
          id: "agent-2-killed",
          createdAt: "2026-07-14T00:00:11.000Z",
          kind: "task.updated",
          payload: { taskId: "agent-2", status: "killed", workflowTaskId: "wf-1" },
        }),
        activity({
          id: "agent-3-completed",
          createdAt: "2026-07-14T00:00:12.000Z",
          kind: "task.completed",
          payload: {
            taskId: "agent-3",
            status: "failed",
            workflowTaskId: "wf-1",
            usage: { total_tokens: 42, tool_uses: 1, duration_ms: 800 },
          },
        }),
      ],
    });

    expect(state?.runningCount).toBe(0);
    expect(
      state?.agents.map((agent) => [agent.taskId, agent.statusKind, agent.statusLabel]),
    ).toEqual([
      ["agent-1", "idle", "Paused"],
      ["agent-2", "stopped", "Stopped"],
      ["agent-3", "failed", "Failed"],
    ]);
    expect(state?.agents[2]?.durationMs).toBe(800);
  });

  it("links rows to subagent child threads by tool use id", () => {
    const state = deriveWorkflowRunState({
      activities: [workflowStarted(), agentStarted({ toolUseId: "tool-1" })],
      subagentThreadsByToolUseId: new Map([
        ["tool-1", { threadId: "subagent:thread-1:tool-1", model: "custom-fast-model" }],
      ]),
    });

    expect(state?.agents[0]?.threadId).toBe("subagent:thread-1:tool-1");
    expect(state?.agents[0]?.modelLabel).toBe("Custom Fast Model");
  });

  it("retires once the workflow run settles", () => {
    const settled = deriveWorkflowRunState({
      activities: [
        workflowStarted(),
        agentStarted(),
        activity({
          id: "workflow-completed",
          createdAt: "2026-07-14T00:01:00.000Z",
          kind: "task.completed",
          payload: { taskId: "wf-1", status: "stopped" },
        }),
      ],
    });
    expect(settled).toBeNull();
  });

  it("prefers the latest workflow run when an earlier one already settled", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted(),
        activity({
          id: "workflow-killed",
          createdAt: "2026-07-14T00:01:00.000Z",
          kind: "task.updated",
          payload: { taskId: "wf-1", status: "killed" },
        }),
        workflowStarted({ id: "workflow-started-2", taskId: "wf-2" }),
      ],
    });
    expect(state?.workflowTaskId).toBe("wf-2");
  });
});

describe("workflowElapsedMs", () => {
  it("uses the wall clock for live rows and reported durations otherwise", () => {
    const startedAt = "2026-07-14T00:00:00.000Z";
    const nowMs = Date.parse("2026-07-14T00:00:30.000Z");
    expect(workflowElapsedMs({ durationMs: 4_500, statusKind: "running", startedAt }, nowMs)).toBe(
      30_000,
    );
    expect(
      workflowElapsedMs({ durationMs: 4_500, statusKind: "completed", startedAt }, nowMs),
    ).toBe(4_500);
    expect(
      workflowElapsedMs({ durationMs: null, statusKind: "stopped", startedAt }, nowMs),
    ).toBeNull();
  });
});
