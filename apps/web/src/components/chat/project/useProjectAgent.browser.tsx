// FILE: useProjectAgent.browser.tsx
// Purpose: Covers the project-agent hook's stream handling — config-upserted
//          derives `configured` and loads the lists on the first configure,
//          refreshes only the thread index on later config/task events, and a
//          second instance's unmount does not unsubscribe the first.
// Layer: Chat UI hook browser tests
// Depends on: useProjectAgent plus a stubbed nativeApi.

import "~/index.css";

import {
  ProjectAgentConfig,
  ProjectGoalId,
  ProjectId,
  ProjectTask,
  ProjectTaskId,
  ThreadId,
  type ProjectAgentOverview,
  type ProjectAgentStreamEvent,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const PROJECT_ID = ProjectId.makeUnsafe("project-group-1");

const harness = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    api: {
      projectAgent: {
        getOverview: vi.fn(),
        listTasks: vi.fn(async () => ({ tasks: [] })),
        listActivity: vi.fn(async () => ({ activity: [], nextCursor: null })),
        listDocuments: vi.fn(async () => ({ documents: [] })),
        listThreadIndex: vi.fn(async () => ({ threads: [] })),
        subscribe: vi.fn(async () => undefined),
        unsubscribe: vi.fn(async () => undefined),
        onEvent: vi.fn((listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
      },
    },
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

import { useProjectAgent } from "./useProjectAgent";

function overview(overrides: Partial<ProjectAgentOverview> = {}): ProjectAgentOverview {
  return {
    projectId: PROJECT_ID,
    configured: false,
    config: null,
    goal: null,
    digest: null,
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "unconfigured",
    ...overrides,
  } as ProjectAgentOverview;
}

function configPayload(projectId: ProjectId = PROJECT_ID): ProjectAgentConfig {
  return ProjectAgentConfig.makeUnsafe({
    projectId,
    coordinatorThreadId: ThreadId.makeUnsafe("thread-coordinator"),
    coordinatorName: "alpha Coordinator",
    coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
    limits: {
      maxConcurrentWorkers: 4,
      maxNewWorkersPerTurn: 2,
      maxWorkerCreationsPerGoal: 12,
      maxAutomaticContinuationsPerGoal: 2,
      maxRepairRoundsPerTask: 2,
    },
    captureEnabled: true,
    enabled: true,
    automationId: null,
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    disabledAt: null,
  });
}

function emitProjectAgentEvent(event: ProjectAgentStreamEvent) {
  harness.listeners.forEach((listener) => listener(event));
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const agent = useProjectAgent({ projectId: PROJECT_ID, enabled });
  return (
    <output data-testid="agent-probe">
      {JSON.stringify({
        configured: agent.overview?.configured ?? null,
        tasks: agent.tasks.length,
        threads: agent.threads.length,
      })}
    </output>
  );
}

describe("useProjectAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.listeners.clear();
    harness.api.projectAgent.getOverview.mockResolvedValue(overview());
  });

  it("derives configured and loads the lists on the first config-upserted", async () => {
    // After the configure write the server's getOverview reports configured —
    // the transition load must not regress to a stale unconfigured payload.
    harness.api.projectAgent.getOverview
      .mockResolvedValueOnce(overview())
      .mockResolvedValue(
        overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
      );
    await render(<Probe />);
    await vi.waitFor(() => expect(harness.api.projectAgent.getOverview).toHaveBeenCalledOnce());

    emitProjectAgentEvent({ type: "config-upserted", config: configPayload() });

    await expect.element(page.getByTestId("agent-probe")).toHaveTextContent('"configured":true');
    await vi.waitFor(() => {
      expect(harness.api.projectAgent.listTasks).toHaveBeenCalledOnce();
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledOnce();
      expect(harness.api.projectAgent.listActivity).toHaveBeenCalledOnce();
      expect(harness.api.projectAgent.listDocuments).toHaveBeenCalledOnce();
    });
    // The transition load doubles as the second getOverview.
    expect(harness.api.projectAgent.getOverview).toHaveBeenCalledTimes(2);
  });

  it("refreshes only the thread index on later config and task upserts", async () => {
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
    );
    await render(<Probe />);
    await vi.waitFor(() => expect(harness.api.projectAgent.listTasks).toHaveBeenCalledOnce());
    expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledOnce();

    emitProjectAgentEvent({ type: "config-upserted", config: configPayload() });
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledTimes(2),
    );
    expect(harness.api.projectAgent.listTasks).toHaveBeenCalledOnce();

    const task = ProjectTask.makeUnsafe({
      id: ProjectTaskId.makeUnsafe("task-1"),
      projectId: PROJECT_ID,
      goalId: ProjectGoalId.makeUnsafe("goal-1"),
      title: "write tests",
      description: null,
      acceptanceCriteria: null,
      status: "running",
      dependsOnTaskIds: [],
      assignedThreadId: ThreadId.makeUnsafe("thread-worker-1"),
      repairCount: 0,
      archivedAt: null,
      revision: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    emitProjectAgentEvent({ type: "task-upserted", task });
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledTimes(3),
    );
    await expect.element(page.getByTestId("agent-probe")).toHaveTextContent('"tasks":1');
  });

  it("keeps the first instance subscribed when a second instance unmounts", async () => {
    const first = await render(<Probe />);
    const second = await render(<Probe />);
    await vi.waitFor(() => expect(harness.api.projectAgent.subscribe).toHaveBeenCalledTimes(2));
    const listenersBefore = harness.listeners.size;
    expect(listenersBefore).toBe(2);

    await second.unmount();
    expect(harness.api.projectAgent.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.listeners.size).toBe(1);

    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: true, config: configPayload(), coordinatorStatus: "idle" }),
    );
    emitProjectAgentEvent({ type: "config-upserted", config: configPayload() });
    await expect.element(page.getByTestId("agent-probe")).toHaveTextContent('"configured":true');

    await first.unmount();
    expect(harness.api.projectAgent.unsubscribe).toHaveBeenCalledTimes(2);
    expect(harness.listeners.size).toBe(0);
  });
});
