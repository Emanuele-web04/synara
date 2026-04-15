import {
  CheckpointRef,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  applyOrchestrationEvents,
  collapseProjectsExcept,
  markThreadUnread,
  renameProjectLocally,
  reorderProjects,
  setThreadWorkspace,
  setAllProjectsExpanded,
  syncServerReadModel,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    envMode: "local",
    branch: null,
    worktreePath: null,
    forkSourceThreadId: null,
    handoff: null,
    ...overrides,
  };
}

function makeDomainEvent<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<Extract<OrchestrationEvent, { type: TType }>, "type" | "payload">> = {},
): Extract<OrchestrationEvent, { type: TType }> {
  const aggregateId = "threadId" in payload ? payload.threadId : ProjectId.makeUnsafe("project-1");
  return {
    type,
    payload,
    sequence: overrides.sequence ?? 1,
    eventId: overrides.eventId ?? EventId.makeUnsafe(`event-${crypto.randomUUID()}`),
    aggregateKind: overrides.aggregateKind ?? "thread",
    aggregateId,
    occurredAt: overrides.occurredAt ?? "2026-02-27T00:00:00.000Z",
    commandId: overrides.commandId ?? null,
    causationEventId: overrides.causationEventId ?? null,
    correlationId: overrides.correlationId ?? null,
    metadata: overrides.metadata ?? {},
    ...overrides,
  } as Extract<OrchestrationEvent, { type: TType }>;
}

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [makeProject()],
    threads: [thread],
    sidebarThreadSummaryById: {},
    threadsHydrated: true,
  };
}

function makeProject(
  overrides: Partial<AppState["projects"][number]> = {},
): AppState["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    remoteName: "Project",
    folderName: "project",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    expanded: true,
    scripts: [],
    ...overrides,
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    forkSourceThreadId: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    handoff: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("preserves a semantic branch when a temp worktree branch arrives from the read model", () => {
    const initialThread = makeThread({
      branch: "feature/semantic-branch",
      updatedAt: "2026-02-27T00:00:00.000Z",
    });

    const next = syncServerReadModel(
      makeState(initialThread),
      makeReadModel(
        makeReadModelThread({
          branch: "dpcode/abc123ef",
          updatedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    expect(next.threads[0]?.branch).toBe("feature/semantic-branch");
  });

  it("does not regress a semantic branch when local workspace patches only report a temp branch", () => {
    const state = makeState(
      makeThread({
        branch: "feature/semantic-branch",
      }),
    );

    const next = setThreadWorkspace(state, ThreadId.makeUnsafe("thread-1"), {
      branch: "dpcode/abc123ef",
    });

    expect(next.threads[0]?.branch).toBe("feature/semantic-branch");
  });

  it("stores server-provided sidebar metadata on hydrated threads", () => {
    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          latestUserMessageAt: "2026-02-27T00:03:00.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          hasActionableProposedPlan: true,
          updatedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    expect(next.threads[0]).toMatchObject({
      latestUserMessageAt: "2026-02-27T00:03:00.000Z",
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
    });
    expect(next.sidebarThreadSummaryById["thread-1"]).toMatchObject({
      latestUserMessageAt: "2026-02-27T00:03:00.000Z",
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
    });
  });

  it("falls back to local derivation when server summary metadata is absent", () => {
    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          messages: [
            {
              id: "message-user" as Thread["messages"][number]["id"],
              role: "user",
              text: "hello",
              turnId: null,
              streaming: false,
              source: "native",
              createdAt: "2026-02-27T00:03:00.000Z",
              updatedAt: "2026-02-27T00:03:00.000Z",
            },
          ],
        }),
      ),
    );

    expect(next.threads[0]?.latestUserMessageAt).toBeUndefined();
    expect(next.sidebarThreadSummaryById["thread-1"]?.latestUserMessageAt).toBe(
      "2026-02-27T00:03:00.000Z",
    );
  });

  it("updates latest turn and thread error immediately from session-set events", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "provider crashed",
          updatedAt: "2026-02-27T00:02:00.000Z",
        },
      }),
    ]);

    expect(next.threads[0]?.error).toBe("provider crashed");
    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "error",
      completedAt: "2026-02-27T00:02:00.000Z",
    });
  });

  it("adds projects immediately from live project.created events", () => {
    const next = applyOrchestrationEvents(
      {
        projects: [],
        threads: [],
        sidebarThreadSummaryById: {},
        threadsHydrated: false,
      },
      [
        makeDomainEvent(
          "project.created",
          {
            projectId: ProjectId.makeUnsafe("project-live"),
            title: "Live Project",
            workspaceRoot: "/tmp/live-project",
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            scripts: [],
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          { aggregateKind: "project" },
        ),
      ],
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]).toMatchObject({
      id: ProjectId.makeUnsafe("project-live"),
      name: "Live Project",
      remoteName: "Live Project",
      folderName: "live-project",
      cwd: "/tmp/live-project",
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
    });
  });

  it("updates existing projects immediately from live project.meta-updated events", () => {
    const initialState: AppState = {
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-live"),
          name: "Local Name",
          remoteName: "Original Name",
          localName: "Local Name",
          folderName: "original-project",
          cwd: "/tmp/original-project",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent(
        "project.meta-updated",
        {
          projectId: ProjectId.makeUnsafe("project-live"),
          title: "Renamed Remotely",
          workspaceRoot: "/tmp/renamed-project",
          defaultModelSelection: null,
          scripts: [
            {
              id: "lint",
              name: "Lint",
              command: "bun lint",
              icon: "lint",
              runOnWorktreeCreate: false,
            },
          ],
          updatedAt: "2026-02-27T00:05:00.000Z",
        },
        { aggregateKind: "project" },
      ),
    ]);

    expect(next.projects[0]).toMatchObject({
      id: ProjectId.makeUnsafe("project-live"),
      name: "Local Name",
      remoteName: "Renamed Remotely",
      folderName: "renamed-project",
      localName: "Local Name",
      cwd: "/tmp/renamed-project",
      defaultModelSelection: null,
      updatedAt: "2026-02-27T00:05:00.000Z",
      scripts: [
        {
          id: "lint",
          name: "Lint",
          command: "bun lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ],
    });
  });

  it("removes projects immediately from live project.deleted events", () => {
    const next = applyOrchestrationEvents(
      {
        projects: [makeProject({ id: ProjectId.makeUnsafe("project-live") })],
        threads: [],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      },
      [
        makeDomainEvent(
          "project.deleted",
          {
            projectId: ProjectId.makeUnsafe("project-live"),
            deletedAt: "2026-02-27T00:06:00.000Z",
          },
          { aggregateKind: "project" },
        ),
      ],
    );

    expect(next.projects).toEqual([]);
  });

  it("settles a running latest turn immediately when session stop is requested", () => {
    const initialState = makeState(
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-running"),
          createdAt: "2026-02-27T00:01:00.000Z",
          updatedAt: "2026-02-27T00:01:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-running"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: MessageId.makeUnsafe("assistant-running"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.session-stop-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-02-27T00:02:00.000Z",
      }),
    ]);

    expect(next.threads[0]?.session).toMatchObject({
      status: "closed",
      orchestrationStatus: "stopped",
      activeTurnId: undefined,
      updatedAt: "2026-02-27T00:02:00.000Z",
    });
    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-running"),
      state: "interrupted",
      requestedAt: "2026-02-27T00:01:00.000Z",
      startedAt: "2026-02-27T00:01:05.000Z",
      completedAt: "2026-02-27T00:02:00.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-running"),
    });
  });

  it("keeps pending proposed-plan linkage across live turn updates", () => {
    const sourceProposedPlan = {
      threadId: ThreadId.makeUnsafe("thread-source"),
      planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
    };
    const next = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message"),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
        createdAt: "2026-02-27T00:01:00.000Z",
        sourceProposedPlan,
      }),
      makeDomainEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-message"),
        role: "assistant",
        text: "Done",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: "2026-02-27T00:01:05.000Z",
        updatedAt: "2026-02-27T00:01:06.000Z",
        attachments: [],
        source: "native",
      }),
    ]);

    expect(next.threads[0]?.pendingSourceProposedPlan).toEqual(sourceProposedPlan);
    expect(next.threads[0]?.latestTurn?.sourceProposedPlan).toEqual(sourceProposedPlan);
  });

  it("updates turn diffs and latest turn immediately from live events", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        pendingSourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
        },
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-02-27T00:02:00.000Z",
        status: "ready",
        files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        assistantMessageId: MessageId.makeUnsafe("assistant-message"),
        checkpointTurnCount: 1,
      }),
    ]);

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      completedAt: "2026-02-27T00:02:00.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-message"),
    });
  });

  it("cleans thread state on revert and clears pending proposed plans", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "completed",
          requestedAt: "2026-02-27T00:01:00.000Z",
          startedAt: "2026-02-27T00:01:05.000Z",
          completedAt: "2026-02-27T00:03:00.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        },
        pendingSourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
        },
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "one",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:10.000Z",
            completedAt: "2026-02-27T00:00:10.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "two",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:01:00.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-1"),
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "keep",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:05.000Z",
            updatedAt: "2026-02-27T00:00:05.000Z",
          },
          {
            id: OrchestrationProposedPlanId.makeUnsafe("plan-2"),
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "drop",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:01:05.000Z",
            updatedAt: "2026-02-27T00:01:05.000Z",
          },
        ],
        activities: [
          makeActivity({ id: "activity-1", turnId: "turn-1" }),
          makeActivity({ id: "activity-2", turnId: "turn-2" }),
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:15.000Z",
            status: "ready",
            files: [],
            checkpointTurnCount: 1,
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:03:00.000Z",
            status: "ready",
            files: [],
            checkpointTurnCount: 2,
          },
        ],
      }),
    );

    const next = applyOrchestrationEvents(initialState, [
      makeDomainEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    ]);

    expect(next.threads[0]?.pendingSourceProposedPlan).toBeUndefined();
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("user-1"),
      MessageId.makeUnsafe("assistant-1"),
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual([
      OrchestrationProposedPlanId.makeUnsafe("plan-1"),
    ]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(next.threads[0]?.latestTurn?.turnId).toBe(TurnId.makeUnsafe("turn-1"));
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
        makeProject({
          id: project3,
          name: "Project 3",
          remoteName: "Project 3",
          folderName: "project-3",
          cwd: "/tmp/project-3",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });

  it("expands every project when toggled on", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
          expanded: false,
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = setAllProjectsExpanded(state, true);

    expect(next.projects.map(({ id, expanded }) => ({ id, expanded }))).toEqual([
      { id: project1, expanded: true },
      { id: project2, expanded: true },
    ]);
  });

  it("collapses all projects when toggled off", () => {
    const state: AppState = {
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = setAllProjectsExpanded(state, false);

    expect(next.projects.every((project) => project.expanded === false)).toBe(true);
  });

  it("collapses every project except the active one", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = collapseProjectsExcept(state, project2);

    expect(next.projects.map(({ id, expanded }) => ({ id, expanded }))).toEqual([
      { id: project1, expanded: false },
      { id: project2, expanded: true },
    ]);
  });

  it("renames a project locally without changing its remote or folder names", () => {
    const state = makeState(makeThread());

    const next = renameProjectLocally(state, ProjectId.makeUnsafe("project-1"), "dpcode");

    expect(next.projects[0]).toMatchObject({
      name: "dpcode",
      localName: "dpcode",
      remoteName: "Project",
      folderName: "project",
    });
  });
});

describe("store read model sync", () => {
  it("filters non-fatal runtime errors from thread banners during read model sync", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError:
            "2026-04-12T23:27:41.094760Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.error).toBeNull();
    expect(next.threads[0]?.session?.lastError).toBeUndefined();
  });

  it("reconciles snapshot state even when thread updatedAt matches a prior live event", () => {
    const sourceProposedPlan = {
      threadId: ThreadId.makeUnsafe("thread-source"),
      planId: OrchestrationProposedPlanId.makeUnsafe("plan-source"),
    };
    const liveState = applyOrchestrationEvents(makeState(makeThread()), [
      makeDomainEvent("thread.turn-start-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("user-message"),
        runtimeMode: "full-access",
        interactionMode: DEFAULT_INTERACTION_MODE,
        dispatchMode: "queue",
        createdAt: "2026-02-27T00:05:00.000Z",
        sourceProposedPlan,
      }),
    ]);

    const next = syncServerReadModel(
      liveState,
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-27T00:05:00.000Z",
          latestTurn: null,
          session: null,
        }),
      ),
    );

    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
    expect(next.threads[0]?.latestTurn).toBeNull();
    expect(next.threads[0]?.pendingSourceProposedPlan).toBeUndefined();
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });

  it("preserves expanded project state when a project briefly disappears from the snapshot", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const initialState: AppState = {
      projects: [
        makeProject({
          id: project1,
          name: "Project 1",
          remoteName: "Project 1",
          folderName: "project-1",
          cwd: "/tmp/project-1",
        }),
        makeProject({
          id: project2,
          name: "Project 2",
          remoteName: "Project 2",
          folderName: "project-2",
          cwd: "/tmp/project-2",
        }),
      ],
      threads: [],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const snapshotWithoutProject2: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
      ],
      threads: [],
    };
    const snapshotWithProject2Restored: OrchestrationReadModel = {
      snapshotSequence: 3,
      updatedAt: "2026-02-27T00:01:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
      ],
      threads: [],
    };

    const withoutProject2 = syncServerReadModel(initialState, snapshotWithoutProject2);
    const restored = syncServerReadModel(withoutProject2, snapshotWithProject2Restored);

    expect(restored.projects.find((project) => project.id === project2)?.expanded).toBe(true);
  });

  it("preserves a local project alias across read model syncs", () => {
    const aliasedState = renameProjectLocally(
      makeState(makeThread()),
      ProjectId.makeUnsafe("project-1"),
      "dpcode",
    );

    const next = syncServerReadModel(
      aliasedState,
      makeReadModel(
        makeReadModelThread({
          updatedAt: "2026-02-28T00:00:00.000Z",
        }),
      ),
    );

    expect(next.projects[0]).toMatchObject({
      name: "dpcode",
      localName: "dpcode",
      remoteName: "Project",
      folderName: "project",
    });
  });

  it("keeps a cleared local project alias from reappearing during syncs", async () => {
    const storage = new Map<string, string>();
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
      addEventListener: vi.fn(),
    };
    storage.set(
      "t3code:renderer-state:v8",
      JSON.stringify({
        projectNamesByCwd: {
          "/tmp/project": "dpcode",
        },
      }),
    );
    vi.stubGlobal("window", fakeWindow);
    try {
      vi.resetModules();

      const freshStore = await import("./store");
      const projectId = ProjectId.makeUnsafe("project-1");
      freshStore.useStore.setState((state) => ({
        ...state,
        projects: [
          makeProject({
            id: projectId,
            name: "dpcode",
            localName: "dpcode",
          }),
        ],
        threads: [makeThread()],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      }));

      freshStore.useStore.getState().renameProjectLocally(projectId, null);

      const next = freshStore.syncServerReadModel(
        freshStore.useStore.getState(),
        makeReadModel(
          makeReadModelThread({
            updatedAt: "2026-02-28T00:00:00.000Z",
          }),
        ),
      );

      expect(next.projects[0]).toMatchObject({
        name: "Project",
        localName: null,
        remoteName: "Project",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reuses normalized thread objects when the incoming snapshot is unchanged", () => {
    const readModel = {
      snapshotSequence: 1,
      updatedAt: "2026-02-28T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ],
      threads: [
        makeReadModelThread({
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt: "2026-02-13T00:00:00.000Z",
          updatedAt: "2026-02-28T00:00:00.000Z",
        }),
      ],
    } satisfies OrchestrationReadModel;

    const hydratedState = syncServerReadModel(makeState(makeThread()), readModel);
    const thread = hydratedState.threads[0];
    const next = syncServerReadModel(hydratedState, readModel);

    expect(next.threads[0]).toBe(thread);
  });
});
