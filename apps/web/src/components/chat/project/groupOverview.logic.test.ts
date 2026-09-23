import { describe, expect, it } from "vitest";

import { AutomationDefinition, ProjectId, type ProjectTask, ThreadId } from "@synara/contracts";

import { useStore } from "../../../store";
import type { SidebarThreadSummary } from "../../../types";
import type { ThreadPullRequest } from "../../../hooks/useThreadPullRequests";

import {
  buildGroupThreadRows,
  collectGroupAutomations,
  collectGroupPullRequestRows,
  collectGroupThreadSummaries,
  createGroupNeedsAttentionSelector,
  firstLineOf,
  groupThreadNeedsAttention,
  partitionGroupThreadRows,
  resolveGroupThreadState,
} from "./groupOverview.logic";

const GROUP_ID = ProjectId.makeUnsafe("group-1");
const LINKED_ID = ProjectId.makeUnsafe("linked-1");
const COORDINATOR_THREAD_ID = ThreadId.makeUnsafe("thread-coordinator");

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: GROUP_ID,
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "task-1" as never,
    projectId: GROUP_ID,
    goalId: "goal-1" as never,
    title: "Task",
    description: "line one\nline two",
    acceptanceCriteria: null,
    status: "ready",
    dependsOnTaskIds: [],
    assignedThreadId: null,
    repairCount: 0,
    revision: 1 as never,
    archivedAt: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    ...overrides,
  };
}

function makePr(
  overrides: Partial<NonNullable<ThreadPullRequest>> = {},
): NonNullable<ThreadPullRequest> {
  return {
    number: 1,
    title: "PR",
    url: "https://github.com/o/r/pull/1",
    baseBranch: "main",
    headBranch: "feature",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: null,
    deletions: null,
    changedFiles: null,
    ...overrides,
  };
}

describe("resolveGroupThreadState", () => {
  const base = { task: null, indexArchived: false, pullRequest: null };

  it("waits on pending approvals and pending user input", () => {
    expect(
      resolveGroupThreadState({ ...base, thread: makeThread({ hasPendingApprovals: true }) }),
    ).toBe("waiting");
    expect(
      resolveGroupThreadState({ ...base, thread: makeThread({ hasPendingUserInput: true }) }),
    ).toBe("waiting");
  });

  it("drops pending flags the session can no longer answer", () => {
    const thread = makeThread({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      session: {
        provider: "codex",
        status: "closed",
        activeTurnId: null,
        lastError: null,
        orchestrationStatus: null,
      } as never,
    });
    expect(resolveGroupThreadState({ ...base, thread })).toBe("idle");
  });

  it("waits on errored sessions and failed turns", () => {
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread({
          session: {
            provider: "codex",
            status: "error",
            activeTurnId: null,
            lastError: "boom",
            orchestrationStatus: null,
          } as never,
        }),
      }),
    ).toBe("waiting");
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread({
          latestTurn: {
            turnId: "turn-1" as never,
            state: "error",
            assistantMessageId: null,
            requestedAt: "2026-03-09T10:00:00.000Z",
            startedAt: "2026-03-09T10:00:00.000Z",
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        }),
      }),
    ).toBe("waiting");
  });

  it("marks running and connecting sessions working", () => {
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread({
          session: {
            provider: "codex",
            status: "running",
            activeTurnId: "turn-1" as never,
            lastError: null,
            orchestrationStatus: "running",
          } as never,
        }),
      }),
    ).toBe("working");
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread({
          session: {
            provider: "codex",
            status: "connecting",
            activeTurnId: null,
            lastError: null,
            orchestrationStatus: null,
          } as never,
        }),
      }),
    ).toBe("working");
  });

  it("marks open non-draft PRs ready for review and drafts idle", () => {
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread(),
        pullRequest: makePr({ state: "open" }),
      }),
    ).toBe("review");
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread(),
        pullRequest: makePr({ state: "open", isDraft: true }),
      }),
    ).toBe("idle");
  });

  it("resolves merged/closed PRs, archived threads, and finished tasks", () => {
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread(),
        pullRequest: makePr({ state: "merged" }),
      }),
    ).toBe("resolved");
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread({ archivedAt: "2026-03-09T11:00:00.000Z" }),
      }),
    ).toBe("resolved");
    expect(
      resolveGroupThreadState({
        ...base,
        thread: makeThread({ hasPendingApprovals: true }),
        task: makeTask({ status: "done" }),
      }),
    ).toBe("resolved");
    expect(resolveGroupThreadState({ ...base, thread: makeThread(), indexArchived: true })).toBe(
      "resolved",
    );
  });
});

describe("collectGroupThreadSummaries", () => {
  it("keeps group threads plus member threads in linked repos, minus the coordinator", () => {
    const groupThread = makeThread({ id: ThreadId.makeUnsafe("t-group") });
    const linkedMember = makeThread({
      id: ThreadId.makeUnsafe("t-linked"),
      projectId: LINKED_ID,
    });
    const linkedStray = makeThread({
      id: ThreadId.makeUnsafe("t-stray"),
      projectId: LINKED_ID,
    });
    const coordinator = makeThread({ id: COORDINATOR_THREAD_ID });
    const result = collectGroupThreadSummaries({
      threads: [groupThread, linkedMember, linkedStray, coordinator],
      groupProjectId: GROUP_ID,
      memberThreadIds: new Set([linkedMember.id]),
      coordinatorThreadId: COORDINATOR_THREAD_ID,
    });
    expect(result.map((thread) => thread.id)).toEqual([groupThread.id, linkedMember.id]);
  });
});

describe("buildGroupThreadRows", () => {
  it("labels linked-repo rows and takes the first description line", () => {
    const linked = makeThread({ id: ThreadId.makeUnsafe("t-linked"), projectId: LINKED_ID });
    const task = makeTask({
      assignedThreadId: linked.id,
      description: "  fix the thing  \nmore detail",
    });
    const [row] = buildGroupThreadRows({
      threads: [linked],
      taskByThreadId: new Map([[linked.id, task]]),
      indexArchivedThreadIds: new Set(),
      pullRequests: new Map(),
      projectNameById: new Map([[LINKED_ID, "linked-repo"]]),
      groupProjectId: GROUP_ID,
      groupProjectName: "My group",
    });
    expect(row?.projectName).toBe("linked-repo");
    expect(row?.taskLine).toBe("fix the thing");
    expect(row?.state).toBe("idle");
  });

  it("hides the project name when the thread belongs to the group folder", () => {
    const thread = makeThread();
    const [row] = buildGroupThreadRows({
      threads: [thread],
      taskByThreadId: new Map(),
      indexArchivedThreadIds: new Set(),
      pullRequests: new Map(),
      projectNameById: new Map([[GROUP_ID, "My group"]]),
      groupProjectId: GROUP_ID,
      groupProjectName: "My group",
    });
    expect(row?.projectName).toBeNull();
  });
});

describe("partitionGroupThreadRows", () => {
  it("buckets rows by state newest-first and keeps Resolved collapsible", () => {
    const older = makeThread({
      id: ThreadId.makeUnsafe("t-old"),
      updatedAt: "2026-03-08T10:00:00.000Z",
    });
    const newer = makeThread({
      id: ThreadId.makeUnsafe("t-new"),
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const done = makeThread({
      id: ThreadId.makeUnsafe("t-done"),
      archivedAt: "2026-03-07T10:00:00.000Z",
    });
    const rows = buildGroupThreadRows({
      threads: [older, newer, done],
      taskByThreadId: new Map(),
      indexArchivedThreadIds: new Set(),
      pullRequests: new Map(),
      projectNameById: new Map(),
      groupProjectId: GROUP_ID,
      groupProjectName: "My group",
    });
    const sections = partitionGroupThreadRows(rows);
    expect(sections.get("idle")?.map((row) => row.thread.id)).toEqual([newer.id, older.id]);
    expect(sections.get("resolved")?.map((row) => row.thread.id)).toEqual([done.id]);
  });
});

describe("collectGroupPullRequestRows", () => {
  it("lists only group threads with a PR, open first", () => {
    const open = makeThread({
      id: ThreadId.makeUnsafe("t-open"),
      updatedAt: "2026-03-08T10:00:00.000Z",
    });
    const merged = makeThread({
      id: ThreadId.makeUnsafe("t-merged"),
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const noPr = makeThread({ id: ThreadId.makeUnsafe("t-nopr") });
    const rows = collectGroupPullRequestRows({
      threads: [open, merged, noPr],
      pullRequests: new Map([
        [open.id, makePr({ state: "open" })],
        [merged.id, makePr({ state: "merged" })],
      ]),
      projectNameById: new Map(),
      groupProjectId: GROUP_ID,
      groupProjectName: "My group",
    });
    expect(rows.map((row) => row.thread.id)).toEqual([open.id, merged.id]);
  });
});

describe("collectGroupAutomations", () => {
  const definition = (overrides: Partial<AutomationDefinition>): AutomationDefinition =>
    ({
      id: "auto-1",
      projectId: ProjectId.makeUnsafe("other"),
      sourceThreadId: null,
      name: "Automation",
      prompt: "do it",
      schedule: { type: "manual" },
      enabled: true,
      nextRunAt: null,
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "local",
      interactionMode: "chat",
      worktreeMode: "auto",
      mode: "new_conversation",
      targetThreadId: null,
      maxIterations: null,
      minimumIntervalSeconds: 60,
      maxRuntimeSeconds: null,
      retryPolicy: "once",
      misfirePolicy: "skip",
      acknowledgedRisks: [],
      iterationCount: 0,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      archivedAt: null,
      ...overrides,
    }) as AutomationDefinition;

  it("matches the group project and member threads, skips archived", () => {
    const member = ThreadId.makeUnsafe("t-member");
    const own = definition({ id: "a-own" as never, projectId: GROUP_ID });
    const targeted = definition({ id: "a-target" as never, targetThreadId: member });
    const sourced = definition({ id: "a-source" as never, sourceThreadId: member });
    const archived = definition({
      id: "a-archived" as never,
      projectId: GROUP_ID,
      archivedAt: "2026-03-09T10:00:00.000Z",
    });
    const unrelated = definition({ id: "a-unrelated" as never });
    const result = collectGroupAutomations({
      definitions: [own, targeted, sourced, archived, unrelated],
      groupProjectId: GROUP_ID,
      memberThreadIds: new Set([member]),
    });
    expect(result.map((entry) => entry.id)).toEqual(["a-own", "a-target", "a-source"]);
  });
});

describe("groupThreadNeedsAttention", () => {
  it("lights for pending requests on live sessions only", () => {
    expect(groupThreadNeedsAttention(makeThread({ hasPendingApprovals: true }))).toBe(true);
    expect(
      groupThreadNeedsAttention(
        makeThread({
          hasPendingUserInput: true,
          session: {
            provider: "codex",
            status: "closed",
            activeTurnId: null,
            lastError: null,
            orchestrationStatus: null,
          } as never,
        }),
      ),
    ).toBe(false);
    expect(
      groupThreadNeedsAttention(
        makeThread({
          hasPendingApprovals: true,
          archivedAt: "2026-03-09T11:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });
});

describe("createGroupNeedsAttentionSelector", () => {
  function stateWith(summaries: Record<string, SidebarThreadSummary>) {
    return {
      ...useStore.getState(),
      sidebarThreadSummaryById: summaries,
    };
  }

  it("flags the group when a member thread waits, excluding the coordinator", () => {
    const waiting = makeThread({
      id: ThreadId.makeUnsafe("t-waiting"),
      hasPendingApprovals: true,
    });
    const coordinator = makeThread({
      id: COORDINATOR_THREAD_ID,
      hasPendingApprovals: true,
    });
    const selector = createGroupNeedsAttentionSelector({
      groups: new Map([
        [GROUP_ID, { projectId: GROUP_ID, coordinatorThreadId: COORDINATOR_THREAD_ID }],
      ]),
    });
    expect(selector(stateWith({ [waiting.id]: waiting, [coordinator.id]: coordinator }))).toEqual(
      new Set([GROUP_ID]),
    );
    expect(selector(stateWith({ [coordinator.id]: coordinator }))).toEqual(new Set());
  });

  it("returns a stable Set reference when membership is unchanged", () => {
    const waiting = makeThread({
      id: ThreadId.makeUnsafe("t-waiting"),
      hasPendingApprovals: true,
    });
    const idle = makeThread({ id: ThreadId.makeUnsafe("t-idle") });
    const selector = createGroupNeedsAttentionSelector({
      groups: new Map([[GROUP_ID, { projectId: GROUP_ID }]]),
    });
    const first = selector(stateWith({ [waiting.id]: waiting, [idle.id]: idle }));
    const second = selector(stateWith({ [waiting.id]: waiting, [idle.id]: { ...idle } }));
    expect(second).toBe(first);
  });
});

describe("firstLineOf", () => {
  it("returns the first non-empty trimmed line or null", () => {
    expect(firstLineOf("\n  hello there  \nsecond")).toBe("hello there");
    expect(firstLineOf("   \n   ")).toBeNull();
    expect(firstLineOf(null)).toBeNull();
  });
});
