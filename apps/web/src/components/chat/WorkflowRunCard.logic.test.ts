// FILE: WorkflowRunCard.logic.test.ts
// Purpose: Locks workflow run panel derivation to task-activity folding: workflow
// identity, agent rows from progress descriptions and tagged member tasks, phase
// rail grouping, pause/resume identifiers, and settled-card visibility.
// Layer: Web chat composer tests
// Depends on: deriveWorkflowRunState

import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildWorkflowResumePrompt,
  deriveWorkflowRunState,
  workflowElapsedMs,
} from "./WorkflowRunCard.logic";

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
  workflowPhases?: Array<{ title: string; detail?: string }>;
  workflowAgentPhases?: Record<string, string>;
  workflowAgentPlans?: Record<string, { phase?: string; model?: string; effort?: string }>;
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
      ...(overrides?.workflowPhases ? { workflowPhases: overrides.workflowPhases } : {}),
      ...(overrides?.workflowAgentPhases
        ? { workflowAgentPhases: overrides.workflowAgentPhases }
        : {}),
      ...(overrides?.workflowAgentPlans
        ? { workflowAgentPlans: overrides.workflowAgentPlans }
        : {}),
    },
  });
}

function workflowLiveAgents(overrides: {
  id: string;
  createdAt: string;
  agents: Array<Record<string, string | number | string[]>>;
}): OrchestrationThreadActivity {
  return activity({
    id: overrides.id,
    createdAt: overrides.createdAt,
    kind: "task.progress",
    payload: {
      taskId: "wf-1",
      description: "Workflow agents",
      workflowAgents: overrides.agents,
    },
  });
}

function workflowProgress(overrides: {
  id: string;
  createdAt: string;
  description: string;
}): OrchestrationThreadActivity {
  return activity({
    id: overrides.id,
    createdAt: overrides.createdAt,
    kind: "task.progress",
    payload: {
      taskId: "wf-1",
      detail: overrides.description,
      description: overrides.description,
      usage: { total_tokens: 100, tool_uses: 1, duration_ms: 1_000 },
    },
  });
}

function agentStarted(overrides?: {
  taskId?: string;
  toolUseId?: string;
  workflowTaskId?: string | null;
  subagentType?: string | null;
}): OrchestrationThreadActivity {
  return activity({
    id: `${overrides?.taskId ?? "agent-1"}-started`,
    createdAt: "2026-07-14T00:00:05.000Z",
    kind: "task.started",
    payload: {
      taskId: overrides?.taskId ?? "agent-1",
      ...(overrides?.subagentType === null
        ? {}
        : { subagentType: overrides?.subagentType ?? "researcher" }),
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

  it("treats a paused workflow as settled and resumable", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted(),
        activity({
          id: "wf-launch-paused",
          createdAt: "2026-07-14T00:00:02.000Z",
          kind: "task.updated",
          payload: {
            taskId: "wf-1",
            workflowRunId: "wf_paused",
            workflowScriptPath: "/sessions/abc/workflow-paused.ts",
          },
        }),
        activity({
          id: "wf-paused",
          createdAt: "2026-07-14T00:00:03.000Z",
          kind: "task.updated",
          payload: { taskId: "wf-1", status: "paused" },
        }),
      ],
    });

    expect(state?.status).toBe("paused");
    expect(state?.settled).toBe(true);
    expect(state?.runId).toBe("wf_paused");
    expect(state?.scriptPath).toBe("/sessions/abc/workflow-paused.ts");
  });

  it("links rows to subagent child threads by tool use id", () => {
    const state = deriveWorkflowRunState({
      activities: [workflowStarted(), agentStarted({ toolUseId: "tool-1", subagentType: null })],
      subagentThreadsByToolUseId: new Map([
        ["tool-1", { threadId: "subagent:thread-1:tool-1", model: "custom-fast-model" }],
      ]),
    });

    expect(state?.agents[0]?.threadId).toBe("subagent:thread-1:tool-1");
    expect(state?.agents[0]?.modelLabel).toBe("Custom Fast Model");
  });

  it("drops Task-tool subagent members that already render in the strip", () => {
    const state = deriveWorkflowRunState({
      activities: [workflowStarted(), agentStarted({ toolUseId: "tool-1" })],
    });

    expect(state?.agents).toEqual([]);
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

  it("derives agent rows and the phase rail from workflow progress descriptions", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted({
          workflowPhases: [{ title: "One", detail: "Research" }, { title: "Two" }],
        }),
        workflowProgress({
          id: "wf-progress-1",
          createdAt: "2026-07-14T00:00:05.000Z",
          description: "One: gamma-agent",
        }),
        workflowProgress({
          id: "wf-progress-2",
          createdAt: "2026-07-14T00:00:06.000Z",
          description: "One: beta-agent",
        }),
        workflowProgress({
          id: "wf-progress-3",
          createdAt: "2026-07-14T00:00:20.000Z",
          description: "Two: delta-agent",
        }),
      ],
    });

    expect(
      state?.agents.map((agent) => [agent.description, agent.phase, agent.statusKind]),
    ).toEqual([
      ["gamma-agent", "One", "completed"],
      ["beta-agent", "One", "completed"],
      ["delta-agent", "Two", "running"],
    ]);
    expect(state?.runningCount).toBe(1);
    expect(
      state?.phases?.map((phase) => [
        phase.title,
        phase.doneCount,
        phase.totalCount,
        phase.isCurrent,
      ]),
    ).toEqual([
      ["One", 2, 2, false],
      ["Two", 0, 1, true],
    ]);
    // Progress rows are synthetic; only real task ids feed the dedupe list.
    expect(state?.taskIds).toEqual(["wf-1"]);
  });

  it("buckets member-task rows via the script label map with an Other fallback", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted({
          workflowPhases: [{ title: "One" }, { title: "Two" }],
          workflowAgentPhases: { "Research prior art": "One" },
        }),
        agentStarted({ taskId: "agent-early" }),
        agentStarted({ taskId: "agent-1" }),
        agentStarted({ taskId: "agent-late" }),
      ].map((entry, index): OrchestrationThreadActivity => {
        if (entry.kind !== "task.started" || index === 0) {
          return entry;
        }
        return {
          id: EventId.makeUnsafe(`ordered-${index}`),
          tone: entry.tone,
          kind: entry.kind,
          summary: entry.summary,
          payload: {
            ...(entry.payload as Record<string, unknown>),
            detail:
              index === 1 ? "Mystery task" : index === 2 ? "research PRIOR art" : "Helper task",
          },
          turnId: entry.turnId,
          sequence: entry.sequence,
          createdAt: entry.createdAt,
        };
      }),
    });

    expect(state?.agents.map((agent) => [agent.description, agent.phase])).toEqual([
      ["Mystery task", "Other"],
      ["research PRIOR art", "One"],
      ["Helper task", "One"],
    ]);
    expect(state?.phases?.map((phase) => phase.title)).toEqual(["One", "Two", "Other"]);
  });

  it("keeps the flat phase-less rendering when no phase information exists", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted(),
        agentStarted(),
        workflowProgress({
          id: "wf-progress-bare",
          createdAt: "2026-07-14T00:00:06.000Z",
          description: "gamma-agent",
        }),
      ],
    });

    expect(state?.phases).toBeNull();
    expect(state?.agents.map((agent) => agent.phase)).toEqual([null, null]);
  });

  it("captures resume identifiers and keeps the settled card visible for resume", () => {
    const activities = [
      workflowStarted({ workflowPhases: [{ title: "One" }, { title: "Two" }] }),
      activity({
        id: "wf-launch",
        createdAt: "2026-07-14T00:00:02.000Z",
        kind: "task.updated",
        payload: {
          taskId: "wf-1",
          workflowRunId: "wf_abc123",
          workflowScriptPath: "/sessions/abc/workflow-spec.ts",
        },
      }),
      workflowProgress({
        id: "wf-progress-1",
        createdAt: "2026-07-14T00:00:05.000Z",
        description: "One: gamma-agent",
      }),
      activity({
        id: "wf-stopped",
        createdAt: "2026-07-14T00:01:00.000Z",
        kind: "task.completed",
        payload: { taskId: "wf-1", status: "stopped" },
      }),
    ];

    const state = deriveWorkflowRunState({ activities });
    expect(state?.settled).toBe(true);
    expect(state?.status).toBe("stopped");
    expect(state?.pausedByUser).toBe(false);
    expect(state?.runId).toBe("wf_abc123");
    expect(state?.scriptPath).toBe("/sessions/abc/workflow-spec.ts");
    expect(state?.agents.map((agent) => agent.statusKind)).toEqual(["stopped"]);

    const paused = deriveWorkflowRunState({
      activities,
      pausedByUserTaskIds: new Set(["wf-1"]),
    });
    expect(paused?.pausedByUser).toBe(true);

    expect(deriveWorkflowRunState({ activities, dismissedTaskIds: new Set(["wf-1"]) })).toBeNull();
  });

  it("backfills settled rows from the final workflow agent snapshots", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted({ workflowPhases: [{ title: "One" }, { title: "Two" }] }),
        workflowProgress({
          id: "wf-progress-1",
          createdAt: "2026-07-14T00:00:05.000Z",
          description: "One: gamma-agent",
        }),
        activity({
          id: "wf-launch",
          createdAt: "2026-07-14T00:00:06.000Z",
          kind: "task.updated",
          payload: {
            taskId: "wf-1",
            workflowRunId: "wf_abc123",
            workflowScriptPath: "/sessions/abc/workflow-spec.ts",
          },
        }),
        activity({
          id: "wf-completed",
          createdAt: "2026-07-14T00:01:00.000Z",
          kind: "task.completed",
          payload: {
            taskId: "wf-1",
            status: "completed",
            workflowAgents: [
              { label: "gamma-agent", phaseIndex: 1, state: "failed" },
              {
                label: "epsilon-agent",
                phaseIndex: 2,
                model: "haiku",
                effort: "low",
                state: "completed",
              },
            ],
          },
        }),
      ],
    });

    expect(
      state?.agents.map((agent) => [
        agent.description,
        agent.phase,
        agent.statusKind,
        agent.modelLabel,
        agent.effortLabel,
      ]),
    ).toEqual([
      ["gamma-agent", "One", "failed", undefined, null],
      ["epsilon-agent", "Two", "completed", "Haiku", "low"],
    ]);
    // Everything settled: the last phase with agents is the current one.
    expect(state?.phases?.map((phase) => [phase.title, phase.isCurrent])).toEqual([
      ["One", false],
      ["Two", true],
    ]);
  });

  it("merges live transcript snapshots onto progress rows with live data winning", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted({
          workflowPhases: [{ title: "One" }, { title: "Two" }],
          workflowAgentPlans: {
            "gamma-agent": { phase: "One", model: "haiku", effort: "low" },
          },
        }),
        workflowProgress({
          id: "wf-progress-1",
          createdAt: "2026-07-14T00:00:05.000Z",
          description: "One: gamma-agent",
        }),
        workflowProgress({
          id: "wf-progress-2",
          createdAt: "2026-07-14T00:00:06.000Z",
          description: "One: beta-agent",
        }),
        workflowLiveAgents({
          id: "wf-live-1",
          createdAt: "2026-07-14T00:00:08.000Z",
          agents: [
            {
              agentId: "agent-live-1",
              label: "gamma-agent",
              model: "claude-sonnet-4-6",
              effort: "high",
              state: "completed",
              tokens: 17_325,
              toolCalls: 3,
              recentToolNames: ["WebSearch", "StructuredOutput"],
              promptPreview: "Research prior art in depth.",
              startedAt: "2026-07-14T00:00:05.000Z",
              lastActivityAt: "2026-07-14T00:00:07.500Z",
            },
            {
              agentId: "agent-live-2",
              label: "beta-agent",
              model: "claude-sonnet-4-6",
              state: "running",
              tokens: 2_000,
              toolCalls: 1,
              recentToolNames: ["Read"],
            },
          ],
        }),
      ],
    });

    const gamma = state?.agents.find((agent) => agent.description === "gamma-agent");
    // Live model and effort beat the planned script opts.
    expect(gamma?.model).toBe("claude-sonnet-4-6");
    expect(gamma?.effortLabel).toBe("high");
    expect(gamma?.totalTokens).toBe(17_325);
    expect(gamma?.toolCalls).toBe(3);
    expect(gamma?.statusKind).toBe("completed");
    expect(gamma?.durationMs).toBe(2_500);
    expect(gamma?.promptPreview).toBe("Research prior art in depth.");
    expect(gamma?.recentToolNames).toEqual(["WebSearch", "StructuredOutput"]);
    expect(gamma?.lastToolName).toBe("StructuredOutput");

    const beta = state?.agents.find((agent) => agent.description === "beta-agent");
    expect(beta?.statusKind).toBe("running");
    // No live/planned effort for beta: the label stays empty.
    expect(beta?.effortLabel).toBeNull();
    expect(beta?.totalTokens).toBe(2_000);
    // The synthetic snapshot event must not create a bogus "Workflow agents" row.
    expect(state?.agents.map((agent) => agent.description)).toEqual(["gamma-agent", "beta-agent"]);
  });

  it("attaches unlabeled snapshots by start order and surfaces extra live agents", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted({ workflowPhases: [{ title: "One" }] }),
        workflowProgress({
          id: "wf-progress-1",
          createdAt: "2026-07-14T00:00:05.000Z",
          description: "One: gamma-agent",
        }),
        workflowLiveAgents({
          id: "wf-live-1",
          createdAt: "2026-07-14T00:00:08.000Z",
          agents: [
            { agentId: "agent-live-1", state: "running", tokens: 1_000 },
            { agentId: "agent-live-2", state: "running", tokens: 500 },
          ],
        }),
      ],
    });

    const gamma = state?.agents.find((agent) => agent.description === "gamma-agent");
    expect(gamma?.totalTokens).toBe(1_000);
    // The second snapshot had no matching progress label: it gets its own row.
    const extra = state?.agents.find((agent) => agent.taskId === "wf-1:agent-id:agent-live-2");
    expect(extra?.totalTokens).toBe(500);
    expect(extra?.statusKind).toBe("running");
  });

  it("prefers the final snapshot's phaseTitle over its (1-based) phaseIndex", () => {
    const state = deriveWorkflowRunState({
      activities: [
        workflowStarted({ workflowPhases: [{ title: "Scope" }, { title: "Search" }] }),
        activity({
          id: "wf-launch",
          createdAt: "2026-07-14T00:00:02.000Z",
          kind: "task.updated",
          payload: {
            taskId: "wf-1",
            workflowRunId: "wf_abc123",
            workflowScriptPath: "/sessions/abc/workflow-spec.ts",
          },
        }),
        activity({
          id: "wf-completed",
          createdAt: "2026-07-14T00:01:00.000Z",
          kind: "task.completed",
          payload: {
            taskId: "wf-1",
            status: "completed",
            workflowAgents: [
              {
                label: "scope",
                phaseIndex: 1,
                phaseTitle: "Scope",
                state: "done",
                tokens: 17_325,
                toolCalls: 1,
                durationMs: 12_374,
                lastToolName: "StructuredOutput",
                promptPreview: "Decompose this research question…",
              },
            ],
          },
        }),
      ],
    });

    const scope = state?.agents.find((agent) => agent.description === "scope");
    expect(scope?.phase).toBe("Scope");
    expect(scope?.totalTokens).toBe(17_325);
    expect(scope?.toolCalls).toBe(1);
    expect(scope?.durationMs).toBe(12_374);
    expect(scope?.lastToolName).toBe("StructuredOutput");
    expect(scope?.promptPreview).toBe("Decompose this research question…");
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

describe("buildWorkflowResumePrompt", () => {
  it("keeps the exact resume phrasing", () => {
    expect(buildWorkflowResumePrompt("/sessions/abc/workflow-spec.ts", "wf_abc123")).toBe(
      'Resume the workflow by invoking the Workflow tool with {"scriptPath": "/sessions/abc/workflow-spec.ts", "resumeFromRunId": "wf_abc123"}. Do not modify the script.',
    );
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
