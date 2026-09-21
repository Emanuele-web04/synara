import {
  EventId,
  MessageId,
  ProjectId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationShellStreamEvent,
} from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyShellEvent,
  applyThreadUpdate,
  clearThreadDetailSyncFailureInClientState,
  evictThreadDetailFromClientState,
  markThreadDetailSyncFailedInClientState,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  syncServerShellSnapshot,
  syncServerReadModel,
  syncServerThreadDetailHotPath,
} from "./storeProjection";
import {
  hasThreadDetailResumeCursor,
  resetThreadDetailResumeCursorsForTests,
  setThreadDetailResumeCursor,
} from "./threadDetailResumeCursors";
import type { AppState } from "./storeState";
import { getThreadFromState } from "./threadDerivation";
import {
  makeThread,
  makeDomainEvent,
  makeActivity,
  makeState,
  makeProject,
  makeReadModelThread,
  makeReadModel,
  makeShellSnapshot,
  makeReadModelProject,
  threadsOf,
} from "./storeTestFixtures";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { applyOrchestrationEvents } from "./storeEventReducer";

describe("store projection", () => {
  it("retains an active resend timestamp through binding updates and rollback", () => {
    const at = (minute: number) => `2026-09-17T10:0${minute}:00.000Z`;
    const messageId = MessageId.makeUnsafe("resent");
    const thread = makeThread({
      latestHumanMessageAt: at(1),
      messages: [
        {
          id: messageId,
          role: "user",
          text: "Original",
          dispatchOrigin: "user",
          turnId: null,
          streaming: false,
          createdAt: at(1),
        },
      ],
    });
    let state = makeState(thread);
    const upsertUserMessage = (input: {
      messageId: MessageId;
      createdAt: string;
      updatedAt: string;
      sequence: number;
    }) => {
      const { sequence, ...message } = input;
      state = applyOrchestrationEvents(state, [
        makeDomainEvent(
          "thread.message-sent",
          {
            threadId: thread.id,
            role: "user",
            text: "Edited",
            dispatchOrigin: "user",
            turnId: null,
            streaming: false,
            source: "native",
            ...message,
          },
          { sequence, occurredAt: at(sequence) },
        ),
      ]);
    };
    upsertUserMessage({ messageId, createdAt: at(2), updatedAt: at(2), sequence: 2 });
    expect(threadsOf(state)[0]?.latestHumanMessageAt).toBe(at(2));
    expect(threadsOf(state)[0]?.messages[0]?.createdAt).toBe(at(1));
    upsertUserMessage({ messageId, createdAt: at(1), updatedAt: at(2), sequence: 3 });
    expect(threadsOf(state)[0]?.latestHumanMessageAt).toBe(at(2));
    const nextMessageId = MessageId.makeUnsafe("next");
    upsertUserMessage({
      messageId: nextMessageId,
      createdAt: at(4),
      updatedAt: at(4),
      sequence: 4,
    });
    state = applyOrchestrationEvents(state, [
      makeDomainEvent(
        "thread.conversation-rolled-back",
        {
          threadId: thread.id,
          messageId: nextMessageId,
          numTurns: 1,
        },
        { sequence: 5, occurredAt: at(5) },
      ),
    ]);
    expect(threadsOf(state)[0]?.latestHumanMessageAt).toBe(at(2));
    expect(state.sidebarThreadSummaryById[thread.id]?.latestHumanMessageAt).toBe(at(2));
  });

  it.each(["2026-09-17T10:00:00.000Z", null])(
    "preserves authoritative human recency %s while stale detail awaits hydration",
    (latestHumanMessageAt) => {
      const staleAt = "2026-09-17T10:20:00.000Z";
      const incoming = makeReadModelThread({ latestHumanMessageAt, messages: [] });
      const thread = makeThread({
        id: incoming.id,
        latestHumanMessageAt: staleAt,
        messages: [
          {
            id: MessageId.makeUnsafe("rolled-back-human"),
            role: "user",
            text: "Removed remotely",
            dispatchOrigin: "user",
            turnId: null,
            streaming: false,
            createdAt: staleAt,
          },
        ],
      });
      let state = syncServerShellSnapshot(makeState(thread), {
        ...makeShellSnapshot(incoming),
        snapshotSequence: 20,
      });
      expect(getThreadFromState(state, thread.id)?.messages).toHaveLength(1);
      state = applyThreadUpdate(state, thread.id, (current) => ({
        ...current,
        lastVisitedAt: "2026-09-17T10:30:00.000Z",
      }));
      expect(getThreadFromState(state, thread.id)?.latestHumanMessageAt).toBe(latestHumanMessageAt);
      expect(state.sidebarThreadSummaryById[thread.id]?.latestHumanMessageAt).toBe(
        latestHumanMessageAt,
      );
      state = applyOrchestrationEvents(state, [
        makeDomainEvent(
          "thread.message-sent",
          {
            threadId: thread.id,
            messageId: MessageId.makeUnsafe("automatic-followup"),
            role: "user",
            dispatchOrigin: "automation",
            text: "Continue",
            streaming: false,
            turnId: null,
            source: "native",
            createdAt: "2026-09-17T10:31:00.000Z",
            updatedAt: "2026-09-17T10:31:00.000Z",
          },
          { sequence: 21, occurredAt: "2026-09-17T10:31:00.000Z" },
        ),
      ]);
      expect(getThreadFromState(state, thread.id)?.latestHumanMessageAt).toBe(latestHumanMessageAt);
      expect(state.sidebarThreadSummaryById[thread.id]?.latestHumanMessageAt).toBe(
        latestHumanMessageAt,
      );
    },
  );

  it("retains human recency through partial hydration, reads, agent sends, eviction, and reconnect", () => {
    const humanAt = "2026-09-17T10:00:00.000Z";
    const incoming = makeReadModelThread({ latestHumanMessageAt: humanAt, messages: [] });
    const threadId = incoming.id;
    let state = syncServerShellSnapshot(makeState(makeThread()), makeShellSnapshot(incoming));
    state = syncServerThreadDetailHotPath(state, incoming);
    state = applyThreadUpdate(state, threadId, (thread) => ({
      ...thread,
      lastVisitedAt: "2026-09-17T10:10:00.000Z",
    }));
    for (const [index, dispatchOrigin] of (["agent", "automation", "user"] as const).entries()) {
      const createdAt = `2026-09-17T10:2${index}:00.000Z`;
      state = applyOrchestrationEvents(state, [
        makeDomainEvent(
          "thread.message-sent",
          {
            threadId,
            messageId: MessageId.makeUnsafe(`recency-${index}`),
            role: "user",
            dispatchOrigin,
            text: "Follow-up",
            streaming: false,
            turnId: null,
            source: "native",
            createdAt,
            updatedAt: createdAt,
          },
          { sequence: 10 + index, occurredAt: createdAt },
        ),
      ]);
      expect(getThreadFromState(state, threadId)?.latestHumanMessageAt).toBe(
        dispatchOrigin === "user" ? createdAt : humanAt,
      );
      expect(state.sidebarThreadSummaryById[threadId]?.latestHumanMessageAt).toBe(
        dispatchOrigin === "user" ? createdAt : humanAt,
      );
    }
    state = evictThreadDetailFromClientState(state, threadId);
    expect(getThreadFromState(state, threadId)?.latestHumanMessageAt).toBe(
      "2026-09-17T10:22:00.000Z",
    );
    state = syncServerShellSnapshot(state, {
      ...makeShellSnapshot({ ...incoming, latestHumanMessageAt: humanAt }),
      snapshotSequence: 20,
    });
    expect(state.sidebarThreadSummaryById[threadId]?.latestHumanMessageAt).toBe(humanAt);
  });

  it("restores cache reviews from shell snapshots and retains them during detail eviction", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const incoming = makeReadModelThread({
      claudeCacheReview: {
        reviewId: "cache-review-1",
        messageId: MessageId.makeUnsafe("held-message"),
        sourceEventSequence: 8,
        assessment: {
          observedAt: "2026-09-16T10:00:00.000Z",
          state: "likely-expired",
          source: "session-start",
          contextTokens: 800_000,
        },
        status: "pending",
        createdAt: "2026-09-16T10:00:00.000Z",
      },
    });
    const restored = syncServerShellSnapshot(makeState(makeThread()), makeShellSnapshot(incoming));
    expect(restored.threadShellById?.[threadId]?.claudeCacheReview).toEqual(
      incoming.claudeCacheReview,
    );
    expect(getThreadFromState(restored, threadId)?.claudeCacheReview).toEqual(
      incoming.claudeCacheReview,
    );

    const hydrated = syncServerThreadDetailHotPath(restored, incoming);
    const evicted = evictThreadDetailFromClientState(hydrated, threadId);
    expect(getThreadFromState(evicted, threadId)?.claudeCacheReview).toEqual(
      incoming.claudeCacheReview,
    );

    const cleared = applyShellEvent(evicted, {
      kind: "thread-upserted",
      sequence: 9,
      thread: { ...incoming, claudeCacheReview: null },
    });
    expect(getThreadFromState(cleared, threadId)?.claudeCacheReview).toBeNull();
  });

  it("restores a failed cache review and clears it from an authoritative full snapshot", () => {
    const incoming = makeReadModelThread({
      claudeCacheReview: {
        reviewId: "cache-review-1",
        messageId: MessageId.makeUnsafe("held-message"),
        sourceEventSequence: 8,
        assessment: {
          observedAt: "2026-09-16T10:00:00.000Z",
          state: "likely-expired",
          source: "session-start",
        },
        status: "failed",
        error: "Compaction was interrupted",
        createdAt: "2026-09-16T10:00:00.000Z",
      },
    });
    const restored = syncServerReadModel(makeState(makeThread()), makeReadModel(incoming));
    expect(threadsOf(restored)[0]?.claudeCacheReview).toEqual(incoming.claudeCacheReview);

    const cleared = syncServerReadModel(restored, {
      ...makeReadModel({ ...incoming, claudeCacheReview: null }),
      snapshotSequence: 2,
    });
    expect(threadsOf(cleared)[0]?.claudeCacheReview).toBeNull();
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
          branch: "synara/abc123ef",
          updatedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    expect(threadsOf(next)[0]?.branch).toBe("feature/semantic-branch");
  });

  it("preserves message mention references from read-model snapshots", () => {
    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          messages: [
            {
              id: MessageId.makeUnsafe("message-with-plugin-mention"),
              role: "user",
              text: "Use @linear",
              attachments: [],
              mentions: [{ name: "linear", path: "plugin://linear@openai-curated" }],
              turnId: null,
              streaming: false,
              source: "native",
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    expect(threadsOf(next)[0]?.messages[0]?.mentions).toEqual([
      { name: "linear", path: "plugin://linear@openai-curated" },
    ]);
  });

  it("resets createBranchFlowCompleted when the branch context changes", () => {
    const next = syncServerReadModel(
      makeState(
        makeThread({
          envMode: "worktree",
          branch: "feature/old-name",
          worktreePath: "/tmp/project/.worktrees/old-name",
          associatedWorktreePath: "/tmp/project/.worktrees/old-name",
          associatedWorktreeBranch: "feature/old-name",
          associatedWorktreeRef: "feature/old-name",
          createBranchFlowCompleted: true,
        }),
      ),
      makeReadModel(
        makeReadModelThread({
          envMode: "worktree",
          branch: "feature/new-name",
          worktreePath: "/tmp/project/.worktrees/new-name",
          associatedWorktreePath: "/tmp/project/.worktrees/new-name",
          associatedWorktreeBranch: "feature/new-name",
          associatedWorktreeRef: "feature/new-name",
          createBranchFlowCompleted: false,
          updatedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    expect(threadsOf(next)[0]?.branch).toBe("feature/new-name");
    expect(threadsOf(next)[0]?.createBranchFlowCompleted).toBe(false);
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

    expect(threadsOf(next)[0]).toMatchObject({
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

    expect(threadsOf(next)[0]?.latestUserMessageAt).toBeUndefined();
    expect(next.sidebarThreadSummaryById["thread-1"]?.latestUserMessageAt).toBe(
      "2026-02-27T00:03:00.000Z",
    );
  });

  it("keeps a confirmed project deletion hidden from stale snapshots", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = syncServerReadModel(
      makeState(makeThread({ id: threadId, projectId })),
      makeReadModel(makeReadModelThread({ id: threadId, projectId })),
    );

    const deletedState = removeDeletedProjectFromClientState(initialState, projectId);
    const afterStaleShellSnapshot = syncServerShellSnapshot(
      deletedState,
      makeShellSnapshot({
        id: threadId,
        projectId,
        title: "Stale project thread",
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
        sidechatSourceThreadId: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:30.000Z",
        handoff: null,
        session: null,
      }),
    );
    const afterStaleReadModel = syncServerReadModel(
      deletedState,
      makeReadModel(makeReadModelThread({ id: threadId, projectId })),
    );

    expect(deletedState.deletedProjectIdsById?.[projectId]).toEqual(expect.any(Number));
    expect(deletedState.projects).toEqual([]);
    expect(threadsOf(deletedState)).toEqual([]);
    expect(afterStaleShellSnapshot.projects).toEqual([]);
    expect(threadsOf(afterStaleShellSnapshot)).toEqual([]);
    expect(afterStaleReadModel.projects).toEqual([]);
    expect(threadsOf(afterStaleReadModel)).toEqual([]);
  });

  it("reuses the existing project slot for shell upserts that keep the same workspace root", () => {
    const initialState: AppState = {
      spaces: [],
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-old"),
          name: "Local Name",
          remoteName: "Old Name",
          localName: "Local Name",
          cwd: "/tmp/shared-root",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = applyShellEvent(initialState, {
      kind: "project-upserted",
      sequence: 2,
      project: {
        id: ProjectId.makeUnsafe("project-new"),
        title: "Server Name",
        workspaceRoot: "/tmp/shared-root",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:05:00.000Z",
      },
    } satisfies OrchestrationShellStreamEvent);

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]).toMatchObject({
      id: ProjectId.makeUnsafe("project-new"),
      name: "Local Name",
      remoteName: "Server Name",
      localName: "Local Name",
      cwd: "/tmp/shared-root",
    });
  });

  it("moves shell projects to Void with the deletion timestamp", () => {
    const spaceId = SpaceId.makeUnsafe("space-shell-delete");
    const initialState: AppState = {
      spaces: [
        {
          id: spaceId,
          name: "Work",
          icon: "bag",
          sortOrder: 0,
          createdAt: "2026-07-15T10:00:00.000Z",
          updatedAt: "2026-07-15T10:00:00.000Z",
        },
      ],
      projects: [
        makeProject({
          id: ProjectId.makeUnsafe("project-shell-space"),
          spaceId,
          updatedAt: "2026-07-15T10:00:01.000Z",
        }),
      ],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
    };

    const next = applyShellEvent(initialState, {
      kind: "space-removed",
      sequence: 3,
      spaceId,
      updatedAt: "2026-07-15T10:00:02.000Z",
    } satisfies OrchestrationShellStreamEvent);

    expect(next.spaces).toEqual([]);
    expect(next.projects[0]).toMatchObject({
      spaceId: null,
      updatedAt: "2026-07-15T10:00:02.000Z",
    });
  });

  it("drops descendant thread state when a shell project removal arrives", () => {
    const initialState = syncServerReadModel(
      {
        spaces: [],
        projects: [
          makeProject({
            id: ProjectId.makeUnsafe("project-shell"),
            cwd: "/tmp/project-shell",
          }),
          makeProject({
            id: ProjectId.makeUnsafe("project-other"),
            cwd: "/tmp/project-other",
          }),
        ],
        sidebarThreadSummaryById: {},
        threadsHydrated: true,
      },
      {
        snapshotSequence: 1,
        updatedAt: "2026-02-27T00:00:00.000Z",
        spaces: [],
        projects: [
          makeReadModelProject({
            id: ProjectId.makeUnsafe("project-shell"),
            workspaceRoot: "/tmp/project-shell",
          }),
          makeReadModelProject({
            id: ProjectId.makeUnsafe("project-other"),
            workspaceRoot: "/tmp/project-other",
          }),
        ],
        threads: [
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-project-1"),
            projectId: ProjectId.makeUnsafe("project-shell"),
          }),
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-project-2"),
            projectId: ProjectId.makeUnsafe("project-other"),
          }),
        ],
      },
    );

    const next = applyShellEvent(initialState, {
      kind: "project-removed",
      sequence: 2,
      projectId: ProjectId.makeUnsafe("project-shell"),
    } satisfies OrchestrationShellStreamEvent);

    expect(next.projects.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-other"),
    ]);
    expect(threadsOf(next).map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-project-2"),
    ]);
    expect(next.threadIds).toEqual([ThreadId.makeUnsafe("thread-project-2")]);
    expect(next.threadShellById?.[ThreadId.makeUnsafe("thread-project-1")]).toBeUndefined();
    expect(next.sidebarThreadSummaryById["thread-project-1"]).toBeUndefined();
  });

  it("does not let a stale shell upsert clear optimistic createBranchFlowCompleted", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = syncServerReadModel(
      makeState(
        makeThread({
          envMode: "worktree",
          branch: "feature/semantic-branch",
          worktreePath: "/tmp/project/.worktrees/semantic-branch",
          associatedWorktreePath: "/tmp/project/.worktrees/semantic-branch",
          associatedWorktreeBranch: "feature/semantic-branch",
          associatedWorktreeRef: "feature/semantic-branch",
          createBranchFlowCompleted: true,
        }),
      ),
      makeReadModel(
        makeReadModelThread({
          envMode: "worktree",
          branch: "feature/semantic-branch",
          worktreePath: "/tmp/project/.worktrees/semantic-branch",
          associatedWorktreePath: "/tmp/project/.worktrees/semantic-branch",
          associatedWorktreeBranch: "feature/semantic-branch",
          associatedWorktreeRef: "feature/semantic-branch",
          createBranchFlowCompleted: true,
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = applyShellEvent(initialState, {
      kind: "thread-upserted",
      sequence: 2,
      thread: {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        envMode: "worktree",
        branch: "feature/semantic-branch",
        worktreePath: "/tmp/project/.worktrees/semantic-branch",
        associatedWorktreePath: "/tmp/project/.worktrees/semantic-branch",
        associatedWorktreeBranch: "feature/semantic-branch",
        associatedWorktreeRef: "feature/semantic-branch",
        createBranchFlowCompleted: false,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        lastKnownPr: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:05:00.000Z",
        archivedAt: null,
        handoff: null,
        session: null,
      },
    });

    expect(next.threadShellById?.[threadId]?.createBranchFlowCompleted).toBe(true);
  });

  it("preserves thread annotations through the normalized read-model projection", () => {
    // a shell upsert must update shell-owned goals while preserving detail-only values (pinned messages, notes)
    const messageId = MessageId.makeUnsafe("assistant-pin-1");
    const pinnedMessages = [
      { messageId, label: null, done: false, pinnedAt: "2026-02-27T00:01:00.000Z" },
    ];
    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          pinnedMessages,
          notes: "remember to rerun typecheck",
          goal: "Finish the release safely",
        }),
      ),
    );

    expect(threadsOf(next)[0]?.pinnedMessages).toEqual(pinnedMessages);
    expect(threadsOf(next)[0]?.notes).toBe("remember to rerun typecheck");
    expect(threadsOf(next)[0]?.goal).toBe("Finish the release safely");
  });

  it("applies shell goals without clobbering detail annotations", () => {
    // Shell snapshots carry goals but not pinned messages or notes. A shell upsert must update the former while preserving detail-only values.
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("assistant-pin-3");
    const pinnedMessages = [
      { messageId, label: null, done: true, pinnedAt: "2026-02-27T00:03:00.000Z" },
    ];
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          pinnedMessages,
          notes: "keep me",
          goal: "Keep the old goal",
          goalStartedAt: "2026-02-27T00:01:00.000Z",
          goalPausedAt: "2026-02-27T00:02:00.000Z",
        }),
      ),
    );

    const next = applyShellEvent(initialState, {
      kind: "thread-upserted",
      sequence: 2,
      thread: {
        id: threadId,
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
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
        createBranchFlowCompleted: false,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        lastKnownPr: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:05:00.000Z",
        archivedAt: null,
        handoff: null,
        goal: "Use the shell goal",
        goalStartedAt: "2026-02-27T00:03:00.000Z",
        goalPausedAt: null,
        session: null,
      },
    });

    expect(threadsOf(next)[0]?.pinnedMessages).toEqual(pinnedMessages);
    expect(threadsOf(next)[0]?.notes).toBe("keep me");
    expect(threadsOf(next)[0]?.goal).toBe("Use the shell goal");
    expect(threadsOf(next)[0]?.goalStartedAt).toBe("2026-02-27T00:03:00.000Z");
    expect(threadsOf(next)[0]?.goalPausedAt).toBeNull();
  });

  it("preserves cross-task creation provenance from the read model", () => {
    const sourceThreadId = ThreadId.makeUnsafe("source-thread");
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        creationSource: "synara_mcp",
        sourceThreadId,
      }),
    );

    const next = syncServerReadModel(initialState, readModel);
    const thread = getThreadFromState(next, ThreadId.makeUnsafe("thread-1"));

    expect(thread?.creationSource).toBe("synara_mcp");
    expect(thread?.sourceThreadId).toBe(sourceThreadId);
  });

  it("carries creationSource onto the sidebar summary and rebuilds it when only that field changes", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initial = syncServerReadModel(
      makeState(makeThread({ id: threadId })),
      makeReadModel(makeReadModelThread({ id: threadId })),
    );
    const before = initial.sidebarThreadSummaryById[threadId];
    expect(before?.creationSource).toBeNull();

    const next = syncServerReadModel(
      initial,
      makeReadModel(makeReadModelThread({ id: threadId, creationSource: "automation_run" })),
    );
    const after = next.sidebarThreadSummaryById[threadId];

    expect(after?.creationSource).toBe("automation_run");
    // creationSource is significant — a snapshot changing only this field (the 091 backfill replaying into a live client) must produce a fresh summary
    expect(after).not.toBe(before);
  });

  it("evicts high-cardinality thread detail while preserving its shell and sidebar summary", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const hydrated = syncServerReadModel(
      makeState(makeThread({ id: threadId })),
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          messages: [
            {
              id: MessageId.makeUnsafe("message-1"),
              role: "assistant",
              text: "cached transcript",
              attachments: [],
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:00:00.000Z",
              streaming: false,
              source: "native",
              dispatchMode: "queue",
              turnId: null,
            },
          ],
        }),
      ),
    );
    const shell = hydrated.threadShellById?.[threadId];
    const summary = hydrated.sidebarThreadSummaryById[threadId];

    const evicted = evictThreadDetailFromClientState(hydrated, threadId);

    expect(evicted.threadShellById?.[threadId]).toBe(shell);
    expect(evicted.sidebarThreadSummaryById[threadId]).toBe(summary);
    expect(evicted.messageIdsByThreadId?.[threadId]).toBeUndefined();
    expect(evicted.messageByThreadId?.[threadId]).toBeUndefined();
    expect(threadsOf(evicted).find((thread) => thread.id === threadId)?.messages).toEqual([]);
  });

  it("adds the desktop bridge token to server attachment preview URLs", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const testWindow = {
      location: { origin: "synara://app" },
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:53036/?token=desktop-secret",
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: testWindow,
    });
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        messages: [
          {
            id: MessageId.makeUnsafe("message-with-image"),
            role: "user",
            text: "see image",
            attachments: [
              {
                type: "image",
                id: "thread-1-image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
            source: "native",
            dispatchMode: "queue",
            turnId: null,
          },
        ],
      }),
    );

    try {
      const next = syncServerReadModel(initialState, readModel);

      expect(threadsOf(next)[0]?.messages[0]?.attachments?.[0]).toMatchObject({
        previewUrl: "http://127.0.0.1:53036/attachments/thread-1-image?token=desktop-secret",
      });
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

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

    expect(threadsOf(next)[0]?.error).toBeNull();
    expect(threadsOf(next)[0]?.session?.lastError).toBeUndefined();
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

    expect(threadsOf(next)[0]?.modelSelection.model).toBe("claude-opus-4-6");
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

    expect(threadsOf(next)[0]?.modelSelection.model).toBe("claude-sonnet-5");
  });

  it("preserves OpenCode as the active session provider", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "opencode",
          model: "openrouter/gpt-oss-120b:free",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "opencode",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(threadsOf(next)[0]?.modelSelection.provider).toBe("opencode");
    expect(threadsOf(next)[0]?.session?.provider).toBe("opencode");
  });

  it("preserves Pi as the active session provider", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "pi",
          model: "anthropic/claude-sonnet-4-5",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "pi",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(threadsOf(next)[0]?.modelSelection.provider).toBe("pi");
    expect(threadsOf(next)[0]?.session?.provider).toBe("pi");
  });

  it("preserves exact OpenCode thread model slugs from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(threadsOf(next)[0]?.modelSelection.model).toBe("openai/gpt-5.4");
  });

  it("preserves exact OpenCode project default model slugs from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = {
      ...makeReadModel(makeReadModelThread({})),
      projects: [
        makeReadModelProject({
          defaultModelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        }),
      ],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.defaultModelSelection?.model).toBe("openai/gpt-5.4");
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
    expect(threadsOf(next)[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("preserves a newer live assistant intro when a hot-path snapshot lags behind", () => {
    const threadId = ThreadId.makeUnsafe("thread-hot-path");
    const turnId = TurnId.makeUnsafe("turn-hot-path");
    const assistantId = MessageId.makeUnsafe("assistant-hot-path");
    const liveState = makeState(
      makeThread({
        id: threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
        },
        session: {
          provider: "claudeAgent",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: assistantId,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("user-hot-path"),
            role: "user",
            text: "scan repo",
            turnId,
            createdAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: assistantId,
            role: "assistant",
            text: "I'll start by scanning the repo.",
            turnId,
            createdAt: "2026-02-27T00:00:01.000Z",
            streaming: true,
            source: "native",
          },
        ],
      }),
    );

    const next = syncServerThreadDetailHotPath(
      liveState,
      makeReadModelThread({
        id: threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
        },
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        updatedAt: "2026-02-27T00:00:02.000Z",
        messages: [
          {
            id: MessageId.makeUnsafe("user-hot-path"),
            role: "user",
            text: "scan repo",
            turnId,
            streaming: false,
            source: "native",
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
            attachments: [],
          },
        ],
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
      }),
    );

    const nextThread = threadsOf(next).find((thread) => thread.id === threadId);
    expect(nextThread?.messages.find((message) => message.id === assistantId)?.text).toBe(
      "I'll start by scanning the repo.",
    );
    expect(nextThread?.latestTurn?.assistantMessageId).toBe(assistantId);
    expect(nextThread?.latestTurn?.state).toBe("running");
    expect(nextThread?.latestTurn?.completedAt).toBeNull();
    expect(nextThread?.session?.orchestrationStatus).toBe("running");
    expect(nextThread?.session?.activeTurnId).toBe(turnId);
  });

  it("applies incoming dispatch origin corrections while retaining live message text", () => {
    const threadId = ThreadId.makeUnsafe("thread-origin-hot-path");
    const messageId = MessageId.makeUnsafe("message-origin-hot-path");
    const liveState = makeState(
      makeThread({
        id: threadId,
        messages: [
          {
            id: messageId,
            role: "user",
            text: "automation draft that is still longer locally",
            dispatchOrigin: "automation",
            turnId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            streaming: true,
            source: "native",
          },
        ],
      }),
    );

    const next = syncServerThreadDetailHotPath(
      liveState,
      makeReadModelThread({
        id: threadId,
        updatedAt: "2026-02-27T00:00:02.000Z",
        messages: [
          {
            id: messageId,
            role: "user",
            text: "human edit",
            dispatchOrigin: "user",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
            attachments: [],
          },
        ],
      }),
    );

    const message = getThreadFromState(next, threadId)?.messages.find(
      (entry) => entry.id === messageId,
    );
    expect(message?.text).toBe("automation draft that is still longer locally");
    expect(message?.dispatchOrigin).toBe("user");
  });

  it("stops preserving a live assistant intro once the read model settles the same turn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const threadId = ThreadId.makeUnsafe("thread-hot-path-settled");
    const turnId = TurnId.makeUnsafe("turn-hot-path-settled");
    const assistantId = MessageId.makeUnsafe("assistant-hot-path-settled");
    const liveState = makeState(
      makeThread({
        id: threadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: assistantId,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("user-hot-path-settled"),
            role: "user",
            text: "/review",
            turnId,
            createdAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: assistantId,
            role: "assistant",
            text: "Reviewing current changes.",
            turnId,
            createdAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
            source: "native",
          },
        ],
      }),
    );

    const completedAt = "2026-02-27T00:00:05.000Z";
    const next = syncServerThreadDetailHotPath(
      liveState,
      makeReadModelThread({
        id: threadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt,
          assistantMessageId: assistantId,
        },
        updatedAt: completedAt,
        messages: [
          {
            id: MessageId.makeUnsafe("user-hot-path-settled"),
            role: "user",
            text: "/review",
            turnId,
            streaming: false,
            source: "native",
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
            attachments: [],
          },
          {
            id: assistantId,
            role: "assistant",
            text: "Review complete.",
            turnId,
            streaming: false,
            source: "native",
            createdAt: "2026-02-27T00:00:01.000Z",
            updatedAt: completedAt,
            attachments: [],
          },
        ],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: completedAt,
        },
      }),
    );

    try {
      expect(next.threadTurnStateById?.[threadId]?.latestTurn?.state).toBe("completed");
      expect(next.threadTurnStateById?.[threadId]?.latestTurn?.completedAt).toBe(completedAt);
      expect(next.threadSessionById?.[threadId]?.orchestrationStatus).toBe("ready");
      expect(next.threadSessionById?.[threadId]?.activeTurnId).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("adopts a settled session when the snapshot's terminal turn supersedes the preserved one", () => {
    const threadId = ThreadId.makeUnsafe("thread-hot-path-superseded");
    const staleTurnId = TurnId.makeUnsafe("turn-hot-path-stale");
    const settledTurnId = TurnId.makeUnsafe("turn-hot-path-settled-next");
    const assistantId = MessageId.makeUnsafe("assistant-hot-path-superseded");
    const liveState = makeState(
      makeThread({
        id: threadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: staleTurnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
        latestTurn: {
          turnId: staleTurnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: assistantId,
        },
        messages: [
          {
            id: assistantId,
            role: "assistant",
            text: "Working on it.",
            turnId: staleTurnId,
            createdAt: "2026-02-27T00:00:01.000Z",
            streaming: true,
            source: "native",
          },
        ],
      }),
    );

    const completedAt = "2026-02-27T00:01:00.000Z";
    const next = syncServerThreadDetailHotPath(
      liveState,
      makeReadModelThread({
        id: threadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        latestTurn: {
          turnId: settledTurnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:30.000Z",
          startedAt: "2026-02-27T00:00:30.000Z",
          completedAt,
          assistantMessageId: null,
        },
        updatedAt: completedAt,
        messages: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: completedAt,
        },
      }),
    );

    expect(next.threadTurnStateById?.[threadId]?.latestTurn).toMatchObject({
      turnId: settledTurnId,
      state: "completed",
      completedAt,
    });
    expect(next.threadSessionById?.[threadId]?.orchestrationStatus).toBe("ready");
    expect(next.threadSessionById?.[threadId]?.activeTurnId).toBeUndefined();
  });

  it("keeps the local session running when a same-timestamp snapshot carries a different terminal turn", () => {
    const threadId = ThreadId.makeUnsafe("thread-hot-path-ambiguous");
    const liveTurnId = TurnId.makeUnsafe("turn-hot-path-live");
    const priorTurnId = TurnId.makeUnsafe("turn-hot-path-prior");
    const assistantId = MessageId.makeUnsafe("assistant-hot-path-ambiguous");
    const sharedUpdatedAt = "2026-02-27T00:00:02.000Z";
    const liveState = makeState(
      makeThread({
        id: threadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: liveTurnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: sharedUpdatedAt,
        },
        latestTurn: {
          turnId: liveTurnId,
          state: "running",
          requestedAt: sharedUpdatedAt,
          startedAt: sharedUpdatedAt,
          completedAt: null,
          assistantMessageId: assistantId,
        },
        messages: [
          {
            id: assistantId,
            role: "assistant",
            text: "Starting the follow-up.",
            turnId: liveTurnId,
            createdAt: sharedUpdatedAt,
            streaming: true,
            source: "native",
          },
        ],
      }),
    );

    const next = syncServerThreadDetailHotPath(
      liveState,
      makeReadModelThread({
        id: threadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        latestTurn: {
          turnId: priorTurnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: sharedUpdatedAt,
          assistantMessageId: null,
        },
        updatedAt: sharedUpdatedAt,
        messages: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: sharedUpdatedAt,
        },
      }),
    );

    expect(next.threadSessionById?.[threadId]?.orchestrationStatus).toBe("running");
    expect(next.threadSessionById?.[threadId]?.activeTurnId).toBe(liveTurnId);
  });

  it("keeps sidebar summaries shell-owned during hot-path thread detail syncs", () => {
    const initialState = syncServerReadModel(
      makeState(makeThread({ title: "Original title" })),
      makeReadModel(
        makeReadModelThread({
          title: "Original title",
          updatedAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    );

    const next = syncServerThreadDetailHotPath(
      initialState,
      makeReadModelThread({
        title: "Renamed title",
        archivedAt: "2026-02-27T00:05:00.000Z",
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    expect(next.sidebarThreadSummaryById["thread-1"]).toMatchObject({
      title: "Original title",
      archivedAt: null,
    });
  });

  it("creates an initial sidebar summary when hot-path detail sync sees a new thread first", () => {
    const threadId = ThreadId.makeUnsafe("thread-detail-before-shell");
    const initialState: AppState = {
      ...makeState(makeThread()),
      threadIds: [],
      sidebarThreadSummaryById: {},
    };

    const next = syncServerThreadDetailHotPath(
      initialState,
      makeReadModelThread({
        id: threadId,
        title: "Visible while running",
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-detail-before-shell"),
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threadIds).toContain(threadId);
    expect(next.sidebarThreadSummaryById[threadId]).toMatchObject({
      id: threadId,
      title: "Visible while running",
      latestTurn: {
        state: "running",
      },
    });
  });

  it("keeps createBranchFlowCompleted sticky during stale hot-path detail syncs", () => {
    const threadId = ThreadId.makeUnsafe("thread-hot-path-branch-flow");
    const liveState = makeState(
      makeThread({
        id: threadId,
        branch: "synara/tmp-working",
        worktreePath: "/tmp/worktrees/thread-hot-path-branch-flow",
        createBranchFlowCompleted: true,
      }),
    );

    const next = syncServerThreadDetailHotPath(
      liveState,
      makeReadModelThread({
        id: threadId,
        branch: "synara/tmp-working",
        worktreePath: "/tmp/worktrees/thread-hot-path-branch-flow",
        createBranchFlowCompleted: false,
      }),
    );

    expect(
      threadsOf(next).find((thread) => thread.id === threadId)?.createBranchFlowCompleted,
    ).toBe(true);
    expect(next.threadShellById?.[threadId]?.createBranchFlowCompleted).toBe(true);
  });

  it("dedupes read-model activity snapshots without losing rich command payloads", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const richActivity = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        data: {
          item: {
            type: "commandExecution",
            command: `/bin/zsh -lc 'find apps packages -maxdepth 2 -type d | sort'`,
          },
        },
      },
    });
    const genericDuplicate = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      payload: { title: "Ran command" },
    });

    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          activities: [richActivity, genericDuplicate],
        }),
      ),
    );

    expect(threadsOf(next)[0]?.activities).toEqual([richActivity]);
    expect(next.activityIdsByThreadId?.[threadId]).toEqual(["activity-command"]);
    expect(next.activityByThreadId?.[threadId]?.["activity-command"]).toBe(richActivity);
  });

  it("caps stored activity detail to the latest activity window", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const activities = Array.from({ length: 2005 }, (_, index) =>
      makeActivity({
        id: `activity-${index}`,
        sequence: index,
        createdAt: "2026-02-27T00:00:00.000Z",
      }),
    );

    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ activities })),
    );

    expect(threadsOf(next)[0]?.activities).toHaveLength(2000);
    expect(threadsOf(next)[0]?.activities[0]?.id).toBe(EventId.makeUnsafe("activity-5"));
    expect(threadsOf(next)[0]?.activities.at(-1)?.id).toBe(EventId.makeUnsafe("activity-2004"));
    expect(next.activityIdsByThreadId?.[threadId]).toHaveLength(2000);
    expect(next.activityIdsByThreadId?.[threadId]?.[0]).toBe("activity-5");
  });

  it("keeps pending interaction activities outside the latest activity window", () => {
    const activities = [
      makeActivity({
        id: "approval-old",
        kind: "approval.requested",
        tone: "approval",
        payload: { requestId: "approval-1", requestKind: "command" },
        sequence: 0,
      }),
      ...Array.from({ length: 2005 }, (_, index) =>
        makeActivity({
          id: `activity-${index}`,
          sequence: index + 1,
          createdAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    ];

    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ activities })),
    );

    expect(threadsOf(next)[0]?.activities).toHaveLength(2001);
    expect(threadsOf(next)[0]?.activities[0]?.id).toBe(EventId.makeUnsafe("approval-old"));
    expect(threadsOf(next)[0]?.activities[1]?.id).toBe(EventId.makeUnsafe("activity-5"));
  });

  it("does not keep resolved interaction activities outside the latest activity window", () => {
    const activities = [
      makeActivity({
        id: "approval-old",
        kind: "approval.requested",
        tone: "approval",
        payload: { requestId: "approval-1", requestKind: "command" },
        sequence: 0,
      }),
      makeActivity({
        id: "approval-resolved-old",
        kind: "approval.resolved",
        tone: "approval",
        payload: { requestId: "approval-1", decision: "accept" },
        sequence: 1,
      }),
      ...Array.from({ length: 2005 }, (_, index) =>
        makeActivity({
          id: `activity-${index}`,
          sequence: index + 2,
          createdAt: "2026-02-27T00:00:00.000Z",
        }),
      ),
    ];

    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({ activities })),
    );

    expect(threadsOf(next)[0]?.activities).toHaveLength(2000);
    expect(threadsOf(next)[0]?.activities[0]?.id).toBe(EventId.makeUnsafe("activity-5"));
    expect(threadsOf(next)[0]?.activities.at(-1)?.id).toBe(EventId.makeUnsafe("activity-2004"));
  });

  it("retains archived threads in the synced store for the archived settings panel", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        id: ThreadId.makeUnsafe("thread-archived"),
        archivedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(threadsOf(next)).toHaveLength(1);
    expect(threadsOf(next)[0]?.id).toBe("thread-archived");
    expect(threadsOf(next)[0]?.archivedAt).toBe("2026-02-27T00:05:00.000Z");
    expect(next.sidebarThreadSummaryById["thread-archived"]?.archivedAt).toBe(
      "2026-02-27T00:05:00.000Z",
    );
  });

  it("removes successfully deleted archived threads through the shared client helper", () => {
    const threadId = ThreadId.makeUnsafe("thread-archived");
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          archivedAt: "2026-02-27T00:05:00.000Z",
        }),
      ),
    );

    const next = removeDeletedThreadFromClientState(initialState, threadId);

    expect(threadsOf(next)).toHaveLength(0);
    expect(next.threadIds).not.toContain(threadId);
    expect(next.threadShellById?.[threadId]).toBeUndefined();
    expect(next.sidebarThreadSummaryById[threadId]).toBeUndefined();
  });

  it("keeps a client-deleted thread hidden when a stale shell snapshot includes it", () => {
    const threadId = ThreadId.makeUnsafe("thread-stale-delete");
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          title: "Soon deleted",
        }),
      ),
    );

    const deletedState = removeDeletedThreadFromClientState(initialState, threadId);
    const next = syncServerShellSnapshot(
      deletedState,
      makeShellSnapshot({
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Stale resurrected thread",
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
        sidechatSourceThreadId: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:30.000Z",
        handoff: null,
        session: null,
      }),
    );

    expect(next.deletedThreadIdsById?.[threadId]).toEqual(expect.any(Number));
    expect(threadsOf(next)).toHaveLength(0);
    expect(next.threadIds).not.toContain(threadId);
    expect(next.threadShellById?.[threadId]).toBeUndefined();
    expect(next.sidebarThreadSummaryById[threadId]).toBeUndefined();
  });

  it("does not tombstone shell-only removals so rollback draft ids can rehydrate", () => {
    const threadId = ThreadId.makeUnsafe("thread-shell-removed");
    const initialState = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          id: threadId,
          title: "Shell removed",
        }),
      ),
    );

    const removedState = applyShellEvent(initialState, {
      kind: "thread-removed",
      sequence: 3,
      threadId,
    } satisfies OrchestrationShellStreamEvent);
    const next = syncServerShellSnapshot(
      removedState,
      makeShellSnapshot({
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Rehydrated shell removed thread",
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
        sidechatSourceThreadId: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:30.000Z",
        handoff: null,
        session: null,
      }),
    );

    expect(removedState.deletedThreadIdsById?.[threadId]).toBeUndefined();
    expect(threadsOf(next)).toHaveLength(1);
    expect(next.threadIds).toContain(threadId);
    expect(next.threadShellById?.[threadId]?.title).toBe("Rehydrated shell removed thread");
  });

  it("reuses normalized thread objects when the incoming snapshot is unchanged", () => {
    const readModel = {
      snapshotSequence: 1,
      updatedAt: "2026-02-28T00:00:00.000Z",
      spaces: [],
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
    const thread = threadsOf(hydratedState)[0];
    const next = syncServerReadModel(hydratedState, readModel);

    expect(next.threadShellById).toBe(hydratedState.threadShellById);
    expect(next.threadSessionById).toBe(hydratedState.threadSessionById);
    expect(next.threadTurnStateById).toBe(hydratedState.threadTurnStateById);
    expect(next.sidebarThreadSummaryById).toBe(hydratedState.sidebarThreadSummaryById);
    expect(threadsOf(next)[0]).toBe(thread);
  });
});

describe("thread detail sync state", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");

  it("marks a thread synced when its detail snapshot is applied and clears it on eviction", () => {
    const synced = syncServerThreadDetailHotPath(makeState(makeThread()), makeReadModelThread({}));

    expect(synced.threadDetailSyncById?.[threadId]).toBe("synced");

    const evicted = evictThreadDetailFromClientState(synced, threadId);

    expect(evicted.threadDetailSyncById?.[threadId]).toBeUndefined();
  });

  it("clears the sync flag when a thread is deleted", () => {
    const synced = syncServerThreadDetailHotPath(makeState(makeThread()), makeReadModelThread({}));

    const removed = removeDeletedThreadFromClientState(synced, threadId);

    expect(removed.threadDetailSyncById?.[threadId]).toBeUndefined();
  });

  it("downgrades a synced thread when its stream dies, without touching applied detail", () => {
    const synced = syncServerThreadDetailHotPath(makeState(makeThread()), makeReadModelThread({}));

    const afterFailure = markThreadDetailSyncFailedInClientState(synced, threadId);

    expect(afterFailure.threadDetailSyncById?.[threadId]).toBe("failed");
    expect(afterFailure.messageByThreadId).toBe(synced.messageByThreadId);
    expect(afterFailure.threadShellById).toBe(synced.threadShellById);
  });

  it("records a failure for an unsynced thread and clears it only from the failed state", () => {
    const failed = markThreadDetailSyncFailedInClientState(makeState(makeThread()), threadId);

    expect(failed.threadDetailSyncById?.[threadId]).toBe("failed");

    const cleared = clearThreadDetailSyncFailureInClientState(failed, threadId);

    expect(cleared.threadDetailSyncById?.[threadId]).toBeUndefined();

    const synced = syncServerThreadDetailHotPath(makeState(makeThread()), makeReadModelThread({}));

    expect(clearThreadDetailSyncFailureInClientState(synced, threadId)).toBe(synced);
  });

  it("marks read-model threads synced and drops flags for threads absent from snapshots", () => {
    const ghostId = ThreadId.makeUnsafe("thread-ghost");
    const base = makeState(makeThread());
    const withGhost = {
      ...base,
      threadDetailSyncById: { [ghostId]: "failed" as const },
    };

    const next = syncServerReadModel(withGhost, makeReadModel(makeReadModelThread({})));

    expect(next.threadDetailSyncById?.[threadId]).toBe("synced");
    expect(next.threadDetailSyncById?.[ghostId]).toBeUndefined();
  });
});

describe("deletion tombstone retirement", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const deletedThreadId = ThreadId.makeUnsafe("thread-1");

  function makeEmptyShellSnapshot(snapshotSequence: number) {
    return {
      snapshotSequence,
      updatedAt: "2026-02-27T00:10:00.000Z",
      spaces: [],
      projects: [],
      threads: [],
    };
  }

  function makeShellSnapshotListingDeletedThread(snapshotSequence: number, title: string) {
    return {
      ...makeShellSnapshot({
        id: deletedThreadId,
        projectId,
        title,
        modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:30.000Z",
        handoff: null,
        session: null,
      }),
      snapshotSequence,
    };
  }

  function makeDeletedThreadState(deletedAtSequence: number): AppState {
    const hydrated = syncServerReadModel(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
    );
    return removeDeletedThreadFromClientState(hydrated, deletedThreadId, deletedAtSequence);
  }

  it("retires a thread tombstone once a snapshot at or after the deletion confirms it is gone", () => {
    const deletedState = makeDeletedThreadState(5);
    expect(deletedState.deletedThreadIdsById?.[deletedThreadId]).toBe(5);

    const next = syncServerShellSnapshot(deletedState, makeEmptyShellSnapshot(9));

    expect(next.deletedThreadIdsById?.[deletedThreadId]).toBeUndefined();
    expect(threadsOf(next)).toHaveLength(0);
  });

  it("keeps a thread tombstone when the confirming snapshot predates the deletion", () => {
    const deletedState = makeDeletedThreadState(5);

    // Sequence 3 was generated before the delete was recorded, so its silence proves nothing.
    const next = syncServerShellSnapshot(deletedState, makeEmptyShellSnapshot(3));

    expect(next.deletedThreadIdsById?.[deletedThreadId]).toBe(5);
    expect(threadsOf(next)).toHaveLength(0);
  });

  it("keeps a thread tombstone when a later snapshot still lists the deleted thread", () => {
    const deletedState = makeDeletedThreadState(5);

    const next = syncServerShellSnapshot(
      deletedState,
      makeShellSnapshotListingDeletedThread(9, "Resurrection attempt"),
    );

    expect(next.deletedThreadIdsById?.[deletedThreadId]).toBe(5);
    expect(threadsOf(next)).toHaveLength(0);
  });

  it("retires a project tombstone once the read model reports the project soft-deleted", () => {
    const hydrated = syncServerReadModel(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
    );
    const deletedState = removeDeletedProjectFromClientState(hydrated, projectId, 5);
    expect(deletedState.deletedProjectIdsById?.[projectId]).toBe(5);

    const next = syncServerReadModel(deletedState, {
      ...makeReadModel(
        makeReadModelThread({
          id: deletedThreadId,
          projectId,
          deletedAt: "2026-02-27T00:09:00.000Z",
        }),
      ),
      snapshotSequence: 9,
      projects: [makeReadModelProject({ deletedAt: "2026-02-27T00:09:00.000Z" })],
    });

    expect(next.deletedProjectIdsById?.[projectId]).toBeUndefined();
    expect(next.deletedThreadIdsById?.[deletedThreadId]).toBeUndefined();
    expect(next.projects).toEqual([]);
    expect(threadsOf(next)).toHaveLength(0);
  });

  it("keeps a project tombstone while the read model still lists the project as live", () => {
    const hydrated = syncServerReadModel(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
    );
    const deletedState = removeDeletedProjectFromClientState(hydrated, projectId, 5);

    const next = syncServerReadModel(deletedState, {
      ...makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
      snapshotSequence: 9,
    });

    expect(next.deletedProjectIdsById?.[projectId]).toBe(5);
    expect(next.projects).toEqual([]);
    expect(threadsOf(next)).toHaveLength(0);
  });

  it("does not let a snapshot older than the newest integrated one retire anything", () => {
    const deletedState = makeDeletedThreadState(1);
    // a newer snapshot still listing the thread lets the tombstone survive; a late-arriving older snapshot must not be trusted to retire it
    const afterNewSnapshot = syncServerShellSnapshot(
      deletedState,
      makeShellSnapshotListingDeletedThread(20, "Still listed"),
    );
    expect(afterNewSnapshot.deletedThreadIdsById?.[deletedThreadId]).toBe(1);

    const next = syncServerShellSnapshot(afterNewSnapshot, makeEmptyShellSnapshot(10));

    expect(next.deletedThreadIdsById?.[deletedThreadId]).toBe(1);
  });

  it("does not let a stale shell snapshot resurrect a thread whose tombstone was already retired", () => {
    const deletedState = makeDeletedThreadState(5);

    // Sequence 9 confirms the thread is gone, which legitimately retires the tombstone.
    const retired = syncServerShellSnapshot(deletedState, makeEmptyShellSnapshot(9));
    expect(retired.deletedThreadIdsById?.[deletedThreadId]).toBeUndefined();
    expect(retired.shellSnapshotSequence).toBe(9);

    // a snapshot generated before the delete has nothing filtering it — merging would resurrect the thread, so the whole stale payload is rejected
    const next = syncServerShellSnapshot(
      retired,
      makeShellSnapshotListingDeletedThread(4, "Late stale snapshot"),
    );

    expect(threadsOf(next)).toHaveLength(0);
    expect(next.shellSnapshotSequence).toBe(9);
    expect(next).toBe(retired);
  });

  it("does not let a stale read model resurrect a thread whose tombstone was already retired", () => {
    const deletedState = makeDeletedThreadState(5);

    const retired = syncServerReadModel(deletedState, {
      ...makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
      snapshotSequence: 9,
      threads: [],
    });
    expect(retired.deletedThreadIdsById?.[deletedThreadId]).toBeUndefined();
    expect(retired.shellSnapshotSequence).toBe(9);

    const next = syncServerReadModel(retired, {
      ...makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
      snapshotSequence: 4,
    });

    expect(threadsOf(next)).toHaveLength(0);
    expect(next.shellSnapshotSequence).toBe(9);
    expect(next).toBe(retired);
  });

  it("keeps the thread id registry stable across a read model resync that changes nothing", () => {
    const hydrated = syncServerReadModel(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
    );

    const resynced = syncServerReadModel(
      hydrated,
      makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
    );

    // Identity, not just equality: consumers memoize on this array, and the "nothing changed" fast path in syncServerReadModel is gated on this exact reference surviving.
    expect(resynced.threadIds).toBe(hydrated.threadIds);
    expect(resynced).toBe(hydrated);
  });

  it("keeps the thread id registry stable across a shell snapshot that changes nothing", () => {
    const hydrated = syncServerShellSnapshot(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeShellSnapshotListingDeletedThread(4, "Stable"),
    );

    const resynced = syncServerShellSnapshot(
      hydrated,
      makeShellSnapshotListingDeletedThread(5, "Stable"),
    );

    expect(resynced.threadIds).toBe(hydrated.threadIds);
  });

  it("rebuilds the thread id registry when the snapshot drops a thread", () => {
    const hydrated = syncServerShellSnapshot(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeShellSnapshotListingDeletedThread(4, "Stable"),
    );

    const resynced = syncServerShellSnapshot(hydrated, makeEmptyShellSnapshot(5));

    expect(resynced.threadIds).toEqual([]);
  });

  function makeMultiThreadShellSnapshot(
    snapshotSequence: number,
    threads: readonly { readonly id: string; readonly title: string }[],
  ) {
    const base = makeShellSnapshot({
      id: deletedThreadId,
      projectId,
      title: "Base",
      modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      envMode: "local",
      branch: null,
      worktreePath: null,
      forkSourceThreadId: null,
      sidechatSourceThreadId: null,
      latestTurn: null,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:30.000Z",
      handoff: null,
      session: null,
    });
    return {
      ...base,
      snapshotSequence,
      threads: threads.map((thread) => ({
        ...base.threads[0]!,
        id: ThreadId.makeUnsafe(thread.id),
        title: thread.title,
      })),
    };
  }

  it("reuses the shell record references when a snapshot changes nothing", () => {
    const hydrated = syncServerShellSnapshot(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeShellSnapshotListingDeletedThread(4, "Stable"),
    );

    const resynced = syncServerShellSnapshot(
      hydrated,
      makeShellSnapshotListingDeletedThread(5, "Stable"),
    );

    // The whole point of rebuilding these records in one pass: an unchanged snapshot must not hand every downstream selector three brand-new dictionaries to re-derive from.
    expect(resynced.threadShellById).toBe(hydrated.threadShellById);
    expect(resynced.threadSessionById).toBe(hydrated.threadSessionById);
    expect(resynced.threadTurnStateById).toBe(hydrated.threadTurnStateById);
  });

  it("keeps untouched thread entries stable when one thread changes", () => {
    const hydrated = syncServerShellSnapshot(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeMultiThreadShellSnapshot(4, [
        { id: "thread-a", title: "A" },
        { id: "thread-b", title: "B" },
      ]),
    );

    const resynced = syncServerShellSnapshot(
      hydrated,
      makeMultiThreadShellSnapshot(5, [
        { id: "thread-a", title: "A" },
        { id: "thread-b", title: "B renamed" },
      ]),
    );

    const threadA = ThreadId.makeUnsafe("thread-a");
    const threadB = ThreadId.makeUnsafe("thread-b");
    expect(resynced.threadShellById).not.toBe(hydrated.threadShellById);
    expect(resynced.threadShellById?.[threadA]).toBe(hydrated.threadShellById?.[threadA]);
    expect(resynced.threadShellById?.[threadB]?.title).toBe("B renamed");
    // Only the shells moved, so the sibling records stay put.
    expect(resynced.threadTurnStateById).toBe(hydrated.threadTurnStateById);
  });

  it("stores a missing session as an absent key rather than an explicit null", () => {
    const hydrated = syncServerShellSnapshot(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeShellSnapshotListingDeletedThread(4, "Stable"),
    );

    expect(hydrated.threadSessionById?.[deletedThreadId]).toBeUndefined();
    expect(Object.keys(hydrated.threadSessionById ?? {})).toEqual([]);
  });

  it("drops the session key on a shell event too, instead of leaving an explicit null", () => {
    // the two write paths must agree on record shape, not just content — absent key vs explicit null compare unequal and would replace a record consumers memoize on
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeState(
      makeThread({
        id: threadId,
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
      }),
    );
    expect(initialState.threadSessionById?.[threadId]).not.toBeUndefined();

    const next = applyShellEvent(initialState, {
      kind: "thread-upserted",
      sequence: 2,
      thread: {
        id: threadId,
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
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
        createBranchFlowCompleted: false,
        parentThreadId: null,
        subagentAgentId: null,
        subagentNickname: null,
        subagentRole: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        lastKnownPr: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:05:00.000Z",
        archivedAt: null,
        handoff: null,
        session: null,
      },
    });

    expect(Object.keys(next.threadSessionById ?? {})).toEqual([]);
    expect(getThreadFromState(next, threadId)?.session).toBeNull();
  });

  it("advances the snapshot sequence when a newer read model carries the same content", () => {
    const hydrated = syncServerReadModel(
      makeState(makeThread({ id: deletedThreadId, projectId })),
      makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
    );

    const next = syncServerReadModel(hydrated, {
      ...makeReadModel(makeReadModelThread({ id: deletedThreadId, projectId })),
      snapshotSequence: 30,
    });

    expect(next.shellSnapshotSequence).toBe(30);

    // The sequence is the lower bound for tombstones created afterwards, so a snapshot that predates the deletion must not retire it.
    const deleted = removeDeletedThreadFromClientState(next, deletedThreadId, undefined);
    expect(deleted.deletedThreadIdsById?.[deletedThreadId]).toBe(31);
    expect(
      syncServerShellSnapshot(deleted, makeEmptyShellSnapshot(30)).deletedThreadIdsById?.[
        deletedThreadId
      ],
    ).toBe(31);
  });
});

describe("resume cursor lifecycle in projection transitions", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const threadId = ThreadId.makeUnsafe("thread-1");

  beforeEach(() => {
    resetThreadDetailResumeCursorsForTests();
  });

  function makeStateWithCursor() {
    const state = makeState(makeThread({ id: threadId, projectId }));
    setThreadDetailResumeCursor(threadId, 42);
    return state;
  }

  it("clears the cursor when the thread's detail is evicted", () => {
    const state = makeStateWithCursor();
    evictThreadDetailFromClientState(state, threadId);
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });

  it("clears the cursor when the thread is deleted", () => {
    const state = makeStateWithCursor();
    removeDeletedThreadFromClientState(state, threadId);
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });

  it("clears the cursor when the thread's project is deleted", () => {
    const state = makeStateWithCursor();
    removeDeletedProjectFromClientState(state, projectId);
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });

  it("clears the cursor when a shell thread-removed event drops the thread", () => {
    const state = makeStateWithCursor();
    applyShellEvent(state, { kind: "thread-removed", sequence: 50, threadId });
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });

  it("clears the cursor when a shell snapshot prunes the thread", () => {
    const state = makeStateWithCursor();
    syncServerShellSnapshot(state, {
      snapshotSequence: 60,
      updatedAt: "2026-02-27T00:10:00.000Z",
      spaces: [],
      projects: [],
      threads: [],
    });
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });

  it("clears the cursor when a read-model repair prunes the thread", () => {
    // Repair local state feeds a full read model through this path — a pruned thread's cursor must fall with its wiped detail
    const state = makeStateWithCursor();
    syncServerReadModel(state, {
      ...makeReadModel(makeReadModelThread({ id: threadId, projectId })),
      snapshotSequence: 60,
      threads: [],
    });
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });

  it("clears the cursor when a full read-model sync replaces retained detail", () => {
    // a retained thread's detail is replaced wholesale — a cursor ahead of the replacement would resume past history the new detail lacks
    const state = makeStateWithCursor();
    syncServerReadModel(state, {
      ...makeReadModel(makeReadModelThread({ id: threadId, projectId })),
      snapshotSequence: 60,
    });
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });

  it("clears the cursor when a tombstone rejects the thread's detail snapshot", () => {
    const state = removeDeletedThreadFromClientState(
      makeState(makeThread({ id: threadId, projectId })),
      threadId,
    );
    setThreadDetailResumeCursor(threadId, 42);

    const next = syncServerThreadDetailHotPath(
      state,
      makeReadModelThread({ id: threadId, projectId }),
    );

    // The tombstone discarded the snapshot instead of applying it, so nothing may vouch for detail that was never stored.
    expect(next.threadDetailSyncById?.[threadId]).toBeUndefined();
    expect(hasThreadDetailResumeCursor(threadId)).toBe(false);
  });
});
