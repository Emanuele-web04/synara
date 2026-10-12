import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProjectGoalId,
  ProjectId,
  ProjectTaskId,
  ThreadId,
  type ProjectAgentConfig,
  type ProjectAgentSummary,
  type ProjectThreadIndexEntry,
} from "@synara/contracts";

const listSummaries = vi.fn<() => Promise<{ summaries: ProjectAgentSummary[] }>>();

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    projectAgent: {
      listSummaries,
      onEvent: () => () => {},
    },
  }),
}));

import { useProjectAgentSummariesStore } from "./useProjectAgentSummaries";

const groupId = ProjectId.makeUnsafe("project-group-1");
const repoId = ProjectId.makeUnsafe("project-repo-1");
const coordinatorThreadId = ThreadId.makeUnsafe("thread-coordinator");
const memberThreadId = ThreadId.makeUnsafe("thread-member");
const now = "2026-09-20T00:00:00.000Z";
const limits = {
  maxConcurrentWorkers: 2,
  maxNewWorkersPerTurn: 4,
  maxWorkerCreationsPerGoal: 12,
  maxAutomaticContinuationsPerGoal: 20,
  maxRepairRoundsPerTask: 2,
};

function makeSummary(overrides: Partial<ProjectAgentSummary> = {}): ProjectAgentSummary {
  return {
    projectId: groupId,
    configured: true,
    coordinatorName: "Astra Bot",
    coordinatorThreadId,
    coordinatorIcon: null,
    coordinatorColor: null,
    coordinatorStatus: "idle",
    pausedAt: null,
    archivedAt: null,
    revision: 1,
    ...overrides,
  };
}

function makeIndexRow(overrides: Partial<ProjectThreadIndexEntry> = {}): ProjectThreadIndexEntry {
  return {
    projectId: groupId,
    threadId: memberThreadId,
    excluded: false,
    archived: false,
    summaryStatus: "pending",
    lastUpdatedAt: null,
    lastSummarizedAt: null,
    ...overrides,
  };
}

function resetStore() {
  useProjectAgentSummariesStore.setState({
    summariesByProjectId: new Map(),
    loaded: false,
    membersLoaded: false,
  });
}

beforeEach(() => {
  resetStore();
  listSummaries.mockReset().mockResolvedValue({ summaries: [] });
});

describe("useProjectAgentSummaries store", () => {
  it("applies hasGoal on goal-upserted so the goal chip hides", async () => {
    vi.useFakeTimers();
    try {
      listSummaries.mockResolvedValue({ summaries: [makeSummary({ hasGoal: true })] });
      useProjectAgentSummariesStore.getState().setSummaries([makeSummary()]);
      useProjectAgentSummariesStore.getState().applyEvent({
        type: "goal-upserted",
        goal: {
          id: ProjectGoalId.makeUnsafe("goal-1"),
          projectId: groupId,
          objective: "Ship hubs",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "active",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
      const summary = useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId);
      expect(summary?.hasGoal).toBe(true);
      expect(summary?.coordinatorStatus).toBe("running");

      useProjectAgentSummariesStore.getState().applyEvent({
        type: "goal-upserted",
        goal: {
          id: ProjectGoalId.makeUnsafe("goal-1"),
          projectId: groupId,
          objective: "Ship hubs",
          authorizationSource: "user",
          scopeVersion: 1,
          acceptanceCriteria: null,
          limits,
          status: "completed",
          continuationCount: 0,
          workerCreationCount: 0,
          authorizedAt: now,
          revision: 2,
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(
        useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId)?.hasGoal,
      ).toBe(false);

      // The debounced re-list lands the authoritative union (authorized goal OR
      // config.goal text) — here the config still carries a goal, so it re-arms.
      await vi.advanceTimersByTimeAsync(500);
      expect(listSummaries).toHaveBeenCalled();
      expect(
        useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId)?.hasGoal,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps memberThreadIds through config-upserted and overview patches", () => {
    useProjectAgentSummariesStore
      .getState()
      .setSummaries([makeSummary({ memberThreadIds: [coordinatorThreadId, memberThreadId] })]);
    useProjectAgentSummariesStore.getState().applyEvent({
      type: "config-upserted",
      config: {
        projectId: groupId,
        coordinatorThreadId,
        coordinatorName: "Astra Bot",
        coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 2,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      },
    });
    expect(
      useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId)?.memberThreadIds,
    ).toEqual([coordinatorThreadId, memberThreadId]);

    useProjectAgentSummariesStore.getState().applyOverview({
      projectId: groupId,
      configured: true,
      config: {
        projectId: groupId,
        coordinatorThreadId,
        coordinatorName: "Astra Bot",
        coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 2,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      },
      linkedProjectIds: [repoId],
      goal: null,
      digest: null,
      blockers: [],
      recentOutcomes: [],
      coordinatorStatus: "idle",
    });
    const summary = useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId);
    expect(summary?.memberThreadIds).toEqual([coordinatorThreadId, memberThreadId]);
    expect(summary?.linkedProjectIds).toEqual([repoId]);
  });

  it("re-lists summaries after a task-upserted so member threads reach the sidebar", async () => {
    vi.useFakeTimers();
    try {
      useProjectAgentSummariesStore
        .getState()
        .setSummaries([makeSummary({ memberThreadIds: [coordinatorThreadId] })]);
      listSummaries.mockResolvedValue({
        summaries: [makeSummary({ memberThreadIds: [coordinatorThreadId, memberThreadId] })],
      });
      useProjectAgentSummariesStore.getState().applyEvent({
        type: "task-upserted",
        task: {
          id: ProjectTaskId.makeUnsafe("task-1"),
          projectId: groupId,
          goalId: ProjectGoalId.makeUnsafe("goal-1"),
          title: "Patch repo",
          description: null,
          acceptanceCriteria: null,
          status: "running",
          dependsOnTaskIds: [],
          assignedThreadId: memberThreadId,
          repairCount: 0,
          archivedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(listSummaries).toHaveBeenCalled();
      expect(
        useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId)?.memberThreadIds,
      ).toEqual([coordinatorThreadId, memberThreadId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports member lists loaded only after a full list, not after a row patch", () => {
    const config: ProjectAgentConfig = {
      projectId: groupId,
      coordinatorThreadId,
      coordinatorName: "Astra Bot",
      coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
      limits,
      captureEnabled: true,
      enabled: true,
      automationId: null,
      revision: 2,
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    };
    const state = () => useProjectAgentSummariesStore.getState();
    state().applyEvent({ type: "config-upserted", config });
    // `loaded` flips on the first row, so it cannot stand in for "members known".
    expect(state().loaded).toBe(true);
    expect(state().membersLoaded).toBe(false);
    state().applyOverview({
      projectId: groupId,
      configured: true,
      config,
      linkedProjectIds: [repoId],
      goal: null,
      digest: null,
      blockers: [],
      recentOutcomes: [],
      coordinatorStatus: "idle",
    });
    expect(state().membersLoaded).toBe(false);
    state().applySummary(makeSummary({ memberThreadIds: [coordinatorThreadId] }));
    expect(state().membersLoaded).toBe(false);
    state().setSummaries([]);
    expect(state().membersLoaded).toBe(true);
  });

  it("adds a live index row to the hub's members at once and leaves removals to the re-list", async () => {
    vi.useFakeTimers();
    try {
      const excludedThreadId = ThreadId.makeUnsafe("thread-excluded");
      const archivedThreadId = ThreadId.makeUnsafe("thread-archived");
      useProjectAgentSummariesStore
        .getState()
        .setSummaries([makeSummary({ memberThreadIds: [coordinatorThreadId] })]);
      const members = () =>
        useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId)?.memberThreadIds;
      useProjectAgentSummariesStore.getState().applyEvent({
        type: "thread-index-upserted",
        projectId: groupId,
        threads: [
          makeIndexRow(),
          makeIndexRow(),
          makeIndexRow({ threadId: excludedThreadId, excluded: true }),
          makeIndexRow({ threadId: archivedThreadId, archived: true }),
        ],
      });
      expect(members()).toEqual([coordinatorThreadId, memberThreadId]);
      expect(listSummaries).not.toHaveBeenCalled();

      // An excluded row is not proof the thread left: a task assignment can keep it.
      useProjectAgentSummariesStore.getState().applyEvent({
        type: "thread-index-upserted",
        projectId: groupId,
        threads: [makeIndexRow({ excluded: true })],
      });
      expect(members()).toEqual([coordinatorThreadId, memberThreadId]);

      await vi.advanceTimersByTimeAsync(500);
      expect(listSummaries).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an index row for an unlisted hub to the re-list", async () => {
    vi.useFakeTimers();
    try {
      useProjectAgentSummariesStore.getState().setSummaries([makeSummary()]);
      const before = useProjectAgentSummariesStore.getState().summariesByProjectId;
      useProjectAgentSummariesStore.getState().applyEvent({
        type: "thread-index-upserted",
        projectId: repoId,
        threads: [makeIndexRow({ projectId: repoId })],
      });
      expect(useProjectAgentSummariesStore.getState().summariesByProjectId).toBe(before);
      await vi.advanceTimersByTimeAsync(500);
      expect(listSummaries).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1, 2])(
    "keeps a patched worker when an in-flight list returns revision %i",
    (revision) => {
      vi.useFakeTimers();
      try {
        useProjectAgentSummariesStore
          .getState()
          .setSummaries([makeSummary({ memberThreadIds: [coordinatorThreadId] })]);
        const requestBaseline = useProjectAgentSummariesStore.getState().summariesByProjectId;
        useProjectAgentSummariesStore.getState().applyEvent({
          type: "thread-index-upserted",
          projectId: groupId,
          threads: [makeIndexRow()],
        });
        useProjectAgentSummariesStore
          .getState()
          .setSummaries(
            [makeSummary({ revision, memberThreadIds: [coordinatorThreadId] })],
            requestBaseline,
          );
        expect(
          useProjectAgentSummariesStore.getState().summariesByProjectId.get(groupId)
            ?.memberThreadIds,
        ).toEqual([coordinatorThreadId, memberThreadId]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("list membership race regressions", () => {
  it("accepts the initial members after a config event races the request", () => {
    const state = () => useProjectAgentSummariesStore.getState();
    const requestBaseline = state().summariesByProjectId;
    state().applyEvent({
      type: "config-upserted",
      config: {
        projectId: groupId,
        coordinatorThreadId,
        coordinatorName: "Astra Bot",
        coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      },
    });
    state().setSummaries(
      [makeSummary({ memberThreadIds: [coordinatorThreadId, memberThreadId] })],
      requestBaseline,
    );
    expect(state().membersLoaded).toBe(true);
    expect(state().summariesByProjectId.get(groupId)?.memberThreadIds).toEqual([
      coordinatorThreadId,
      memberThreadId,
    ]);
  });

  it("accepts member removal despite an unrelated metadata patch during the request", () => {
    const state = () => useProjectAgentSummariesStore.getState();
    state().setSummaries([makeSummary({ memberThreadIds: [coordinatorThreadId, memberThreadId] })]);
    const requestBaseline = state().summariesByProjectId;
    state().applySummary(
      makeSummary({
        coordinatorName: "Updated",
        memberThreadIds: [coordinatorThreadId, memberThreadId],
      }),
    );
    state().setSummaries(
      [makeSummary({ memberThreadIds: [coordinatorThreadId] })],
      requestBaseline,
    );
    expect(state().summariesByProjectId.get(groupId)?.coordinatorName).toBe("Updated");
    expect(state().summariesByProjectId.get(groupId)?.memberThreadIds).toEqual([
      coordinatorThreadId,
    ]);
  });

  it("keeps members pending when a racing new row was absent from the list", () => {
    const state = () => useProjectAgentSummariesStore.getState();
    const requestBaseline = state().summariesByProjectId;
    state().applySummary(makeSummary());
    state().setSummaries([], requestBaseline);
    expect(state().summariesByProjectId.has(groupId)).toBe(true);
    expect(state().membersLoaded).toBe(false);
  });
});
