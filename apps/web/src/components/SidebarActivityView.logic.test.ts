import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";

import type { SidebarThreadSummary, ThreadSession } from "../types";

import { resolveThreadStatusPill } from "./Sidebar.logic";
import {
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityThreads,
  collectVisibleActivityThreadIds,
  excludeActivityPriorityThreads,
  findNextThreadNeedingAttention,
  groupActivityThreadsByProject,
  hasActivityNeedingAttention,
  resolveActivityDateBucket,
  resolveActivityPriority,
  resolveActivityPriorityTier,
  resolveActivityScope,
  resolveActivitySectionRows,
  resolveActivityThreadReadAt,
  type ActivityPriorityState,
  type ActivityScopeOption,
  splitActivityThreadsByDateBucket,
} from "./SidebarActivityView.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeSession(status: ThreadSession["status"]): ThreadSession {
  return {
    provider: "codex",
    status,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    orchestrationStatus: status === "running" ? "running" : "idle",
  } as ThreadSession;
}

function makeThread(input: {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  latestTurn?: SidebarThreadSummary["latestTurn"];
  latestHumanMessageAt?: string | null;
  lastVisitedAt?: string;
  session?: ThreadSession | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasLiveTailWork?: boolean;
  archivedAt?: string | null;
  settledAt?: string | null;
  parentThreadId?: string | null;
  isPinned?: boolean;
  projectId?: ProjectId;
}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: input.projectId ?? PROJECT_ID,
    title: `Thread ${input.id}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: input.session ?? null,
    createdAt: input.createdAt ?? "2026-08-01T09:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-01T10:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    settledAt: input.settledAt ?? null,
    isPinned: input.isPinned ?? false,
    latestTurn: input.latestTurn ?? null,
    lastVisitedAt: input.lastVisitedAt,
    parentThreadId: input.parentThreadId ? ThreadId.makeUnsafe(input.parentThreadId) : null,
    latestUserMessageAt: null,
    latestHumanMessageAt: input.latestHumanMessageAt ?? null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: input.hasLiveTailWork ?? false,
    pendingBackgroundWorkCount: 0,
  } satisfies SidebarThreadSummary;
}

function completedTurn(completedAt: string): SidebarThreadSummary["latestTurn"] {
  return {
    turnId: `turn-${completedAt}`,
    state: "completed",
    requestedAt: completedAt,
    startedAt: completedAt,
    completedAt,
  } as SidebarThreadSummary["latestTurn"];
}

/** The tier the sidebar derives from a row's real status pill. */
function tierOf(thread: SidebarThreadSummary, dismissedStatusKey?: string) {
  return resolveActivityPriorityTier(
    resolveThreadStatusPill({
      thread: { ...thread, dismissedStatusKey },
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
    }),
  );
}

const ids = (threads: readonly SidebarThreadSummary[]) => threads.map((thread) => thread.id);

describe("buildActivityViewModel", () => {
  it("keeps snoozed empty top-level threads accessible and restores them after expiry", () => {
    const snoozed = { ...makeThread({ id: "empty" }), snoozedUntil: "2026-08-02T09:00:00.000Z" };
    const archived = {
      ...snoozed,
      id: ThreadId.makeUnsafe("archived"),
      archivedAt: "2026-08-01T12:00:00.000Z",
    };
    const child = { ...snoozed, id: ThreadId.makeUnsafe("child"), parentThreadId: snoozed.id };
    const beforeExpiry = buildActivityViewModel({
      threads: [snoozed, archived, child],
      pinnedThreadIdSet: new Set(),
    });
    expect(beforeExpiry.snoozed.map((row) => row.id)).toEqual(["empty"]);
    const returned = {
      ...snoozed,
      snoozedUntil: null,
      snoozeReminderAt: "2026-08-02T09:00:00.000Z",
    };
    const afterExpiry = buildActivityViewModel({
      threads: [returned],
      pinnedThreadIdSet: new Set(),
    });
    expect(afterExpiry.active.map((row) => row.id)).toEqual(["empty"]);
    expect(
      ids(
        resolveActivityPriority({
          candidates: afterExpiry.active,
          resolveTier: (thread) => tierOf(thread),
          previous: null,
          nowMs: Date.parse("2026-08-02T10:00:00.000Z"),
        }).threads,
      ),
    ).toEqual(["empty"]);
  });

  it("keeps snoozed threads separate before pinned and done, including overdue deadlines", () => {
    const snoozed = {
      ...makeThread({ id: "snoozed", latestTurn: completedTurn("2026-08-01T10:00:00.000Z") }),
      snoozedUntil: "2026-08-01T08:00:00.000Z",
      settledAt: "2026-08-01T11:00:00.000Z",
    };
    const later = {
      ...snoozed,
      id: ThreadId.makeUnsafe("later"),
      snoozedUntil: "2026-08-02T09:00:00.000Z",
    };
    const model = buildActivityViewModel({
      threads: [later, snoozed],
      pinnedThreadIdSet: new Set([snoozed.id]),
    });
    expect(model.snoozed.map((thread) => thread.id)).toEqual(["snoozed", "later"]);
    expect(model.pinned).toEqual([]);
    expect(model.active).toEqual([]);
    expect(model.settled).toEqual([]);
  });

  it("ranks an older thread back into Priority using its reminder time", () => {
    const reminded = {
      ...makeThread({
        id: "reminded",
        latestHumanMessageAt: "2026-07-01T10:00:00.000Z",
        latestTurn: completedTurn("2026-07-01T10:05:00.000Z"),
      }),
      snoozeReminderAt: "2026-08-02T11:30:00.000Z",
    };
    const newer = makeThread({
      id: "newer",
      latestHumanMessageAt: "2026-08-02T10:00:00.000Z",
      latestTurn: completedTurn("2026-08-02T10:05:00.000Z"),
    });
    const model = buildActivityViewModel({
      threads: [newer, reminded],
      pinnedThreadIdSet: new Set(),
    });
    expect(model.active.map((thread) => thread.id)).toEqual(["reminded", "newer"]);
    expect(
      ids(
        resolveActivityPriority({
          candidates: model.active,
          resolveTier: (thread) => tierOf(thread),
          previous: null,
          nowMs: Date.parse("2026-08-02T12:00:00.000Z"),
        }).threads,
      ),
    ).toEqual(["reminded", "newer"]);
  });

  it("keeps human-send order through startup, completion, attention, reads, and MCP sends", () => {
    const older = makeThread({
      id: "older",
      latestHumanMessageAt: "2026-08-01T10:00:00.000Z",
      latestTurn: completedTurn("2026-08-01T10:01:00.000Z"),
    });
    const newer = makeThread({
      id: "newer",
      latestHumanMessageAt: "2026-08-01T10:05:00.000Z",
      hasLiveTailWork: true,
    });
    for (const update of [
      { latestTurn: completedTurn("2026-08-01T10:10:00.000Z") },
      {
        hasPendingUserInput: true,
        session: makeSession("running"),
        updatedAt: "2026-08-01T10:11:00.000Z",
      },
      { lastVisitedAt: "2026-08-01T10:12:00.000Z" },
      { latestUserMessageAt: "2026-08-01T10:13:00.000Z" },
    ]) {
      const model = buildActivityViewModel({
        threads: [{ ...older, ...update }, newer],
        pinnedThreadIdSet: new Set(),
      });
      expect(model.active.map((thread) => thread.id)).toEqual(["newer", "older"]);
    }
  });

  it("breaks equal timestamps deterministically and uses creation only without a human send", () => {
    const a = makeThread({
      id: "a",
      hasLiveTailWork: true,
      latestHumanMessageAt: "2026-08-01T08:00:00.000Z",
    });
    const b = { ...a, id: ThreadId.makeUnsafe("b") };
    const unsent = makeThread({
      id: "unsent",
      hasLiveTailWork: true,
      createdAt: "2026-08-01T07:00:00.000Z",
    });
    for (const threads of [
      [b, unsent, a],
      [a, b, unsent],
    ]) {
      expect(
        buildActivityViewModel({ threads, pinnedThreadIdSet: new Set() }).active.map(
          (thread) => thread.id,
        ),
      ).toEqual(["a", "b", "unsent"]);
    }
  });

  it("keeps two simultaneously running threads in a fixed order while they work", () => {
    const runningTurn = (startedAt: string): SidebarThreadSummary["latestTurn"] =>
      ({
        turnId: `turn-${startedAt}`,
        state: "running",
        requestedAt: startedAt,
        startedAt,
        completedAt: null,
      }) as SidebarThreadSummary["latestTurn"];
    const makeRunning = (id: string, startedAt: string, updatedAt: string) =>
      makeThread({
        id,
        createdAt: "2026-08-01T04:00:00.000Z",
        updatedAt,
        latestHumanMessageAt: startedAt,
        hasLiveTailWork: true,
        latestTurn: runningTurn(startedAt),
      });
    const order = (updatedA: string, updatedB: string) =>
      buildActivityViewModel({
        threads: [
          makeRunning("run-a", "2026-08-01T09:00:00.000Z", updatedA),
          makeRunning("run-b", "2026-08-01T08:00:00.000Z", updatedB),
        ],
        pinnedThreadIdSet: new Set(),
      }).active.map((thread) => thread.id);

    // Whichever thread streamed most recently, the turn each one started still
    // decides the order — the rows must not swap mid-run.
    expect(order("2026-08-01T09:30:00.000Z", "2026-08-01T09:31:00.000Z")).toEqual([
      "run-a",
      "run-b",
    ]);
    expect(order("2026-08-01T09:32:00.000Z", "2026-08-01T09:31:00.000Z")).toEqual([
      "run-a",
      "run-b",
    ]);
  });

  it("keeps every pinned thread exclusively in the Pinned section", () => {
    const pinnedUnread = makeThread({
      id: "pinned-unread",
      latestHumanMessageAt: "2026-08-01T09:30:00.000Z",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const pinnedSeen = makeThread({
      id: "pinned-seen",
      latestHumanMessageAt: "2026-08-01T09:20:00.000Z",
      latestTurn: completedTurn("2026-08-01T09:20:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    const pinnedSettledSeen = makeThread({
      id: "pinned-settled-seen",
      latestHumanMessageAt: "2026-08-01T09:10:00.000Z",
      latestTurn: completedTurn("2026-08-01T09:10:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
      settledAt: "2026-08-01T09:45:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [pinnedUnread, pinnedSeen, pinnedSettledSeen],
      pinnedThreadIdSet: new Set([pinnedUnread.id, pinnedSeen.id, pinnedSettledSeen.id]),
    });

    expect(model.pinned.map((thread) => thread.id)).toEqual([
      "pinned-unread",
      "pinned-seen",
      "pinned-settled-seen",
    ]);
    expect(model.settled).toEqual([]);
    expect(model.active).toEqual([]);
  });

  it("applies optimistic settle overrides in both directions", () => {
    const optimisticallySettled = makeThread({
      id: "opt-settled",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    const optimisticallyRestored = makeThread({
      id: "opt-restored",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
      settledAt: "2026-08-01T09:50:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [optimisticallySettled, optimisticallyRestored],
      pinnedThreadIdSet: new Set(),
      settledOverrideByThreadId: new Map([
        [optimisticallySettled.id, true],
        [optimisticallyRestored.id, false],
      ]),
    });

    expect(model.settled.map((thread) => thread.id)).toEqual(["opt-settled"]);
    expect(model.active.map((thread) => thread.id)).toEqual(["opt-restored"]);
  });

  it("keeps settled threads in place until a new human send", () => {
    const settledAt = "2026-08-01T08:00:00.000Z";
    const running = makeThread({ id: "running", settledAt, hasLiveTailWork: true });
    const attention = makeThread({
      id: "attention",
      settledAt,
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const unseen = makeThread({
      id: "unseen",
      settledAt,
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const reviewed = makeThread({
      id: "reviewed",
      settledAt,
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [reviewed, running, attention, unseen],
      pinnedThreadIdSet: new Set(),
    });

    expect(model.active).toEqual([]);
    expect(model.settled.map((thread) => thread.id)).toEqual([
      "attention",
      "reviewed",
      "running",
      "unseen",
    ]);
    const resumed = buildActivityViewModel({
      threads: [{ ...reviewed, latestHumanMessageAt: "2026-08-01T10:00:00.000Z" }],
      pinnedThreadIdSet: new Set(),
    });
    expect(resumed.active.map((thread) => thread.id)).toEqual(["reviewed"]);
    expect(resumed.settled).toEqual([]);
  });

  it("lifts unsent drafts to the top and keeps pinned drafts first within Pinned", () => {
    const turn = completedTurn("2026-08-01T09:30:00.000Z");
    const newest = makeThread({
      id: "newest",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T12:00:00.000Z",
    });
    const oldDraft = makeThread({
      id: "old-draft",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T08:00:00.000Z",
    });
    const settledDraft = makeThread({
      id: "settled-draft",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T09:00:00.000Z",
      settledAt: "2026-08-01T09:45:00.000Z",
    });
    const pinnedPlain = makeThread({
      id: "pinned-plain",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T11:00:00.000Z",
    });
    const pinnedDraft = makeThread({
      id: "pinned-draft",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T07:00:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [newest, oldDraft, settledDraft, pinnedPlain, pinnedDraft],
      pinnedThreadIdSet: new Set([pinnedPlain.id, pinnedDraft.id]),
      draftThreadIdSet: new Set([oldDraft.id, settledDraft.id, pinnedDraft.id]),
    });

    expect(model.drafts.map((thread) => thread.id)).toEqual(["settled-draft", "old-draft"]);
    expect(model.active.map((thread) => thread.id)).toEqual(["newest"]);
    expect(model.settled).toEqual([]);
    expect(model.pinned.map((thread) => thread.id)).toEqual(["pinned-draft", "pinned-plain"]);
  });

  it("keeps the open thread and working threads out of Drafts while their composer has text", () => {
    const turn = completedTurn("2026-08-01T09:30:00.000Z");
    const idleDraft = makeThread({
      id: "idle-draft",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T08:00:00.000Z",
    });
    const runningDraft = makeThread({
      id: "running-draft",
      session: makeSession("running"),
      latestTurn: null,
      latestHumanMessageAt: "2026-08-01T11:00:00.000Z",
    });
    const connectingDraft = makeThread({
      id: "connecting-draft",
      session: makeSession("connecting"),
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T10:30:00.000Z",
    });
    // Just sent: the session runs but latestTurn is still the previous, settled turn.
    const startingDraft = makeThread({
      id: "starting-draft",
      session: makeSession("running"),
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T10:15:00.000Z",
    });
    const openDraft = makeThread({
      id: "open-draft",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T10:00:00.000Z",
    });
    const pinnedPlain = makeThread({
      id: "pinned-plain",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T12:00:00.000Z",
    });
    const pinnedRunningDraft = makeThread({
      id: "pinned-running-draft",
      session: makeSession("running"),
      latestTurn: null,
      latestHumanMessageAt: "2026-08-01T07:00:00.000Z",
    });
    const pinnedIdleDraft = makeThread({
      id: "pinned-idle-draft",
      latestTurn: turn,
      latestHumanMessageAt: "2026-08-01T06:00:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [
        idleDraft,
        runningDraft,
        connectingDraft,
        startingDraft,
        openDraft,
        pinnedPlain,
        pinnedRunningDraft,
        pinnedIdleDraft,
      ],
      pinnedThreadIdSet: new Set([pinnedPlain.id, pinnedRunningDraft.id, pinnedIdleDraft.id]),
      draftThreadIdSet: new Set([
        idleDraft.id,
        runningDraft.id,
        connectingDraft.id,
        startingDraft.id,
        openDraft.id,
        pinnedRunningDraft.id,
        pinnedIdleDraft.id,
      ]),
      activeThreadId: openDraft.id,
    });

    expect(model.drafts.map((thread) => thread.id)).toEqual(["idle-draft"]);
    expect(model.active.map((thread) => thread.id)).toEqual([
      "running-draft",
      "connecting-draft",
      "starting-draft",
      "open-draft",
    ]);
    // Only the idle draft leads Pinned; the running one keeps its recency slot.
    expect(model.pinned.map((thread) => thread.id)).toEqual([
      "pinned-idle-draft",
      "pinned-plain",
      "pinned-running-draft",
    ]);
  });
});

describe("date buckets", () => {
  // Fixed "now": 2026-08-01T15:00 local time.
  const now = new Date(2026, 7, 1, 15, 0, 0);
  const nowMs = now.getTime();
  const localIso = (year: number, month: number, day: number, hour: number) =>
    new Date(year, month, day, hour).toISOString();

  const threadAt = (iso: string) =>
    makeThread({ id: `thread-${iso}`, createdAt: iso, latestTurn: completedTurn(iso) });

  it("classifies today, yesterday, and earlier by local calendar day", () => {
    expect(resolveActivityDateBucket(threadAt(localIso(2026, 7, 1, 9)), nowMs)).toBe("today");
    expect(resolveActivityDateBucket(threadAt(localIso(2026, 6, 31, 23)), nowMs)).toBe("yesterday");
    expect(resolveActivityDateBucket(threadAt(localIso(2026, 6, 30, 23)), nowMs)).toBe("earlier");
  });

  it("splits an ordered list preserving order inside each bucket", () => {
    const bucketThread = (id: string, iso: string) =>
      makeThread({ id, createdAt: iso, latestTurn: completedTurn(iso) });
    const todayA = bucketThread("today-a", localIso(2026, 7, 1, 14));
    const todayB = bucketThread("today-b", localIso(2026, 7, 1, 8));
    const yesterday = bucketThread("yesterday", localIso(2026, 6, 31, 12));
    const earlier = bucketThread("earlier", localIso(2026, 6, 20, 12));

    const buckets = splitActivityThreadsByDateBucket([todayA, todayB, yesterday, earlier], nowMs);
    expect(buckets.today.map((thread) => thread.id)).toEqual(["today-a", "today-b"]);
    expect(buckets.yesterday.map((thread) => thread.id)).toEqual(["yesterday"]);
    expect(buckets.earlier.map((thread) => thread.id)).toEqual(["earlier"]);
  });
});

describe("project filter", () => {
  const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-2");

  it("narrows every section of the view model", () => {
    const inProject = makeThread({
      id: "in-project",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const otherProject = {
      ...makeThread({
        id: "other-project",
        latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      }),
      projectId: OTHER_PROJECT_ID,
    };

    const model = buildActivityViewModel({
      threads: [inProject, otherProject],
      pinnedThreadIdSet: new Set(),
      projectFilterIds: new Set([PROJECT_ID]),
    });
    expect(model.active.map((thread) => thread.id)).toEqual(["in-project"]);
  });

  it("lists scope options busiest first and ignores drafts", () => {
    const projectA1 = makeThread({
      id: "a1",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const projectB1 = {
      ...makeThread({ id: "b1", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: OTHER_PROJECT_ID,
    };
    const projectB2 = {
      ...makeThread({ id: "b2", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: OTHER_PROJECT_ID,
    };
    const draft = makeThread({ id: "draft", latestTurn: null });

    expect(
      collectActivityScopeOptions([projectA1, projectB1, projectB2, draft], () => true),
    ).toEqual([
      { kind: "project", projectId: OTHER_PROJECT_ID, threadCount: 2 },
      { kind: "project", projectId: PROJECT_ID, threadCount: 1 },
    ]);
  });

  it("merges every project-less chat container into one Synara scope", () => {
    const CHAT_PROJECT_A = ProjectId.makeUnsafe("chat-project-a");
    const CHAT_PROJECT_B = ProjectId.makeUnsafe("chat-project-b");
    const realProject = makeThread({
      id: "real",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const chatA = {
      ...makeThread({ id: "chat-a", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: CHAT_PROJECT_A,
    };
    const chatB = {
      ...makeThread({ id: "chat-b", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: CHAT_PROJECT_B,
    };

    const options = collectActivityScopeOptions(
      [realProject, chatA, chatB],
      (projectId) => projectId === PROJECT_ID,
    );
    expect(options).toEqual([
      { kind: "chats", projectIds: [CHAT_PROJECT_A, CHAT_PROJECT_B], threadCount: 2 },
      { kind: "project", projectId: PROJECT_ID, threadCount: 1 },
    ]);
  });

  it("merges project-less containers into one project-grouping section", () => {
    const CHAT_PROJECT_A = ProjectId.makeUnsafe("chat-project-a");
    const CHAT_PROJECT_B = ProjectId.makeUnsafe("chat-project-b");
    const groups = groupActivityThreadsByProject(
      [
        makeThread({
          id: "project",
          latestHumanMessageAt: "2026-08-01T09:30:00.000Z",
          projectId: PROJECT_ID,
          latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
        }),
        makeThread({
          id: "chat-a",
          projectId: CHAT_PROJECT_A,
          latestTurn: completedTurn("2026-08-01T09:20:00.000Z"),
        }),
        makeThread({
          id: "chat-b",
          projectId: CHAT_PROJECT_B,
          latestTurn: completedTurn("2026-08-01T09:10:00.000Z"),
        }),
      ],
      (projectId) => projectId === PROJECT_ID,
    );

    expect(groups.map((group) => [group.kind, group.threads.map((thread) => thread.id)])).toEqual([
      ["project", ["project"]],
      ["chats", ["chat-a", "chat-b"]],
    ]);
    expect(groups[1]).toMatchObject({
      key: "chats",
      kind: "chats",
      projectIds: [CHAT_PROJECT_A, CHAT_PROJECT_B],
    });
  });

  it("orders projects by human sends without following reads or agent completions", () => {
    const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-2");
    // 01:30 local on Aug 2: the working day still started at 04:00 on Aug 1.
    const localIso = (day: number, hour: number) => new Date(2026, 7, day, hour).toISOString();

    const touched = {
      ...makeThread({
        id: "touched",
        latestHumanMessageAt: localIso(1, 22),
        projectId: PROJECT_ID,
        latestTurn: completedTurn(localIso(1, 22)),
        lastVisitedAt: localIso(1, 22),
      }),
    };
    // Newer agent output, but the user has not opened it since before the turnover.
    const untouched = {
      ...makeThread({
        id: "untouched",
        latestHumanMessageAt: localIso(1, 3),
        projectId: OTHER_PROJECT_ID,
        latestTurn: completedTurn(localIso(2, 1)),
        lastVisitedAt: localIso(1, 3),
      }),
    };

    const groups = groupActivityThreadsByProject([untouched, touched], () => true);
    expect(groups.map((group) => group.key)).toEqual([
      `project:${PROJECT_ID}`,
      `project:${OTHER_PROJECT_ID}`,
    ]);
  });
});

describe("resolveActivityScope", () => {
  const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-2");
  const options: ActivityScopeOption[] = [
    { kind: "project", projectId: PROJECT_ID, threadCount: 2 },
    { kind: "chats", projectIds: [OTHER_PROJECT_ID], threadCount: 1 },
  ];

  it("expands the Synara chats scope to its container projects", () => {
    expect(resolveActivityScope("chats", options)).toEqual({
      scope: "chats",
      projectFilterIds: new Set([OTHER_PROJECT_ID]),
    });
  });

  it("falls back to every project once the selected scope leaves the menu", () => {
    const withoutChats = options.filter((option) => option.kind !== "chats");
    expect(resolveActivityScope("chats", withoutChats)).toEqual({
      scope: null,
      projectFilterIds: null,
    });
    expect(resolveActivityScope(PROJECT_ID, [])).toEqual({ scope: null, projectFilterIds: null });
  });
});

describe("resolveActivityPriority", () => {
  const nowMs = Date.parse("2026-08-02T12:00:00.000Z");
  const working = (id: string, latestHumanMessageAt: string, overrides = {}) =>
    makeThread({ id, latestHumanMessageAt, hasLiveTailWork: true, ...overrides });
  const unread = (id: string, latestHumanMessageAt: string) =>
    makeThread({
      id,
      latestHumanMessageAt,
      latestTurn: completedTurn("2026-08-02T11:00:00.000Z"),
      lastVisitedAt: "2026-08-02T10:00:00.000Z",
    });
  const read = (thread: SidebarThreadSummary): SidebarThreadSummary => ({
    ...thread,
    hasLiveTailWork: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: thread.latestTurn ?? completedTurn("2026-08-02T11:00:00.000Z"),
    lastVisitedAt: "2026-08-02T11:59:00.000Z",
  });
  const waiting = (id: string, latestHumanMessageAt: string) =>
    makeThread({
      id,
      latestHumanMessageAt,
      hasPendingApprovals: true,
      latestTurn: completedTurn(latestHumanMessageAt),
    });
  const priorityOf = (
    candidates: readonly SidebarThreadSummary[],
    previous: ActivityPriorityState | null = null,
  ) =>
    resolveActivityPriority({
      candidates,
      resolveTier: (thread) => tierOf(thread),
      previous,
      nowMs,
    });

  it("maps every status pill to a tier, and a dismissed pill to none", () => {
    expect(resolveActivityPriorityTier({ label: "Pending Approval" })).toBe("waiting");
    expect(resolveActivityPriorityTier({ label: "Awaiting Input" })).toBe("waiting");
    expect(resolveActivityPriorityTier({ label: "Plan Ready" })).toBe("waiting");
    expect(resolveActivityPriorityTier({ label: "Completed" })).toBe("unread");
    expect(resolveActivityPriorityTier({ label: "Reminder" })).toBe("unread");
    expect(resolveActivityPriorityTier({ label: "Working" })).toBe("working");
    expect(resolveActivityPriorityTier({ label: "Connecting" })).toBe("working");
    expect(resolveActivityPriorityTier({ label: "Preparing worktree" })).toBe("working");
    expect(resolveActivityPriorityTier({ label: "In Background" })).toBe("working");
    expect(resolveActivityPriorityTier(null)).toBeNull();

    const approval = waiting("approval", "2026-08-02T09:00:00.000Z");
    const status = resolveThreadStatusPill({
      thread: approval,
      hasPendingApprovals: true,
      hasPendingUserInput: false,
    });
    expect(tierOf(approval, status?.dismissalKey)).toBeNull();
    // A failed turn reads as a completion, so it ranks with unread work.
    const failed = makeThread({
      id: "failed",
      latestTurn: { ...completedTurn("2026-08-02T11:00:00.000Z")!, state: "error" },
    });
    expect(tierOf(failed)).toBe("unread");
  });

  it("ranks waiting, then unread, then working, newest human send first, with no cap", () => {
    const runningIds = ["run-1", "run-2", "run-3", "run-4", "run-5", "run-6", "run-7"];
    const running = runningIds.map((id, index) =>
      working(id, `2026-08-02T0${index + 1}:00:00.000Z`),
    );
    const candidates = [
      ...running,
      unread("unread-old", "2026-08-01T10:00:00.000Z"),
      waiting("waiting-old", "2026-08-01T09:00:00.000Z"),
      unread("unread-new", "2026-08-02T10:00:00.000Z"),
      waiting("waiting-new", "2026-08-02T11:00:00.000Z"),
      read(makeThread({ id: "idle", latestHumanMessageAt: "2026-08-02T11:30:00.000Z" })),
    ];
    const { threads, state } = priorityOf(candidates);
    expect(ids(threads)).toEqual([
      "waiting-new",
      "waiting-old",
      "unread-new",
      "unread-old",
      ...runningIds.toReversed(),
    ]);
    expect(state).toEqual({ threadIds: ids(threads), sortedAtMs: nowMs });
  });

  it("holds rows in place while their status changes and keeps read rows listed", () => {
    const a = waiting("a", "2026-08-02T09:00:00.000Z");
    const b = unread("b", "2026-08-02T10:00:00.000Z");
    const c = working("c", "2026-08-02T11:00:00.000Z");
    const first = priorityOf([a, b, c]);
    expect(ids(first.threads)).toEqual(["a", "b", "c"]);

    // a is answered and runs, b is opened and read, c finishes unseen: nothing moves.
    const next = priorityOf(
      [working("a", "2026-08-02T09:00:00.000Z"), read(b), unread("c", "2026-08-02T11:00:00.000Z")],
      first.state,
    );
    expect(ids(next.threads)).toEqual(["a", "b", "c"]);
    expect(next.state.sortedAtMs).toBe(nowMs);
  });

  it("adds new threads at the top and newly qualifying older ones at the end", () => {
    const a = working("a", "2026-08-02T09:00:00.000Z");
    const later = read(
      makeThread({ id: "later", latestHumanMessageAt: "2026-08-02T11:00:00.000Z" }),
    );
    const first = priorityOf([a, later]);
    expect(ids(first.threads)).toEqual(["a"]);

    const created = working("created", "2026-08-02T12:05:00.000Z", {
      createdAt: "2026-08-02T12:05:00.000Z",
    });
    const next = priorityOf(
      [a, waiting("later", "2026-08-02T11:00:00.000Z"), created],
      first.state,
    );
    expect(ids(next.threads)).toEqual(["created", "a", "later"]);
  });

  it("re-sorts and drops read rows on a fresh sort", () => {
    const a = working("a", "2026-08-02T09:00:00.000Z");
    const b = working("b", "2026-08-02T10:00:00.000Z");
    const first = priorityOf([a, b]);
    expect(ids(first.threads)).toEqual(["b", "a"]);
    const changed = [waiting("a", "2026-08-02T09:00:00.000Z"), read(b)];
    expect(ids(priorityOf(changed, first.state).threads)).toEqual(["b", "a"]);
    expect(ids(priorityOf(changed, null).threads)).toEqual(["a"]);
  });

  it("drops rows that stop being candidates and returns them to their slot", () => {
    const a = working("a", "2026-08-02T09:00:00.000Z");
    const b = working("b", "2026-08-02T10:00:00.000Z");
    const c = working("c", "2026-08-02T11:00:00.000Z");
    const first = priorityOf([a, b, c]);
    // b is marked Done, then the Done is undone after it was read.
    const withoutB = priorityOf([a, c], first.state);
    expect(ids(withoutB.threads)).toEqual(["c", "a"]);
    expect(ids(priorityOf([a, read(b), c], withoutB.state).threads)).toEqual(["c", "b", "a"]);
  });

  it("never loses a thread: every feed row lands in exactly one section", () => {
    const pinnedIds = new Set<ThreadId>();
    const draftIds = new Set<ThreadId>();
    const threads: SidebarThreadSummary[] = [];
    const statuses = ["waiting", "unread", "working", "read"] as const;
    const placements = ["plain", "pinned", "draft", "settled", "snoozed"] as const;
    let index = 0;
    for (const status of statuses) {
      for (const placement of placements) {
        for (const day of ["2026-08-02T09", "2026-08-01T09", "2026-07-20T09"]) {
          index += 1;
          const id = `t-${index}`;
          const sentAt = `${day}:${String(index % 60).padStart(2, "0")}:00.000Z`;
          let thread =
            status === "waiting"
              ? waiting(id, sentAt)
              : status === "unread"
                ? unread(id, sentAt)
                : status === "working"
                  ? working(id, sentAt)
                  : read(makeThread({ id, latestHumanMessageAt: sentAt }));
          if (placement === "settled")
            thread = { ...thread, settledAt: "2026-08-02T11:59:30.000Z" };
          if (placement === "snoozed")
            thread = { ...thread, snoozedUntil: "2026-08-03T09:00:00.000Z" };
          if (placement === "pinned") pinnedIds.add(thread.id);
          if (placement === "draft") draftIds.add(thread.id);
          threads.push(thread);
        }
      }
    }
    const model = buildActivityViewModel({
      threads,
      pinnedThreadIdSet: pinnedIds,
      draftThreadIdSet: draftIds,
    });
    const candidates = [...model.pinned, ...model.drafts, ...model.active];
    const first = priorityOf(candidates);
    // Every row is then read in place; the held rows must still land somewhere exactly once.
    const readCandidates = candidates.map(read);
    for (const priority of [first, priorityOf(readCandidates, first.state)]) {
      const rest = excludeActivityPriorityThreads(model, priority.threads);
      const buckets = splitActivityThreadsByDateBucket(rest.active, nowMs);
      const shown = [
        ...priority.threads,
        ...rest.pinned,
        ...rest.drafts,
        ...buckets.today,
        ...buckets.yesterday,
        ...buckets.earlier,
        ...model.settled,
        ...model.snoozed,
      ].map((thread) => thread.id);
      expect(shown.toSorted()).toEqual(ids(threads).toSorted());
    }
    // Pinned and draft rows that need the user moved up into Priority.
    expect(ids(first.threads)).toEqual(
      expect.arrayContaining(ids(candidates.filter((thread) => tierOf(thread) !== null))),
    );
  });
});

describe("collectVisibleActivityThreadIds", () => {
  it("uses the mounted Activity rows and respects collapsed and paged sections", () => {
    const thread = (id: string) => makeThread({ id });
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "time",
        pinnedOpen: false,
        pinned: [thread("pinned")],
        priority: [thread("priority")],
        drafts: [thread("draft")],
        today: [thread("today")],
        yesterday: [thread("yesterday")],
        earlierOpen: true,
        earlier: [thread("earlier-visible")],
        projectGroups: [],
        settledOpen: false,
        settled: [thread("done")],
      }),
    ).toEqual(["priority", "draft", "today", "yesterday", "earlier-visible"]);
  });

  it("includes the open thread revealed under a collapsed section", () => {
    const thread = (id: string) => makeThread({ id });
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "time",
        pinnedOpen: true,
        pinned: [],
        priority: [thread("priority")],
        drafts: [],
        today: [],
        yesterday: [],
        earlierOpen: false,
        earlier: [],
        projectGroups: [],
        settledOpen: true,
        settled: [thread("done")],
        revealed: { pinned: [], earlier: [thread("old-active")], settled: [] },
      }),
    ).toEqual(["priority", "old-active", "done"]);
  });
});

describe("resolveActivitySectionRows", () => {
  const rows = ["a", "b", "c", "d"].map((id) => makeThread({ id }));

  it("pages an open section normally when the open thread is on the page", () => {
    const result = resolveActivitySectionRows(rows, {
      open: true,
      previewLimit: 2,
      activeThreadId: ThreadId.makeUnsafe("b"),
    });
    expect(ids(result.visible)).toEqual(["a", "b"]);
    expect(result.revealed).toEqual([]);
  });

  it("appends the open thread when it sits past the page cap", () => {
    const result = resolveActivitySectionRows(rows, {
      open: true,
      previewLimit: 2,
      activeThreadId: ThreadId.makeUnsafe("d"),
    });
    expect(ids(result.visible)).toEqual(["a", "b", "d"]);
    expect(result.revealed).toEqual([]);
  });

  it("reveals only the open thread under a collapsed header", () => {
    const result = resolveActivitySectionRows(rows, {
      open: false,
      previewLimit: 2,
      activeThreadId: ThreadId.makeUnsafe("c"),
    });
    expect(result.visible).toEqual([]);
    expect(ids(result.revealed)).toEqual(["c"]);
  });

  it("reveals nothing when the open thread is not in the section", () => {
    for (const activeThreadId of [ThreadId.makeUnsafe("elsewhere"), null]) {
      expect(
        resolveActivitySectionRows(rows, { open: false, previewLimit: 2, activeThreadId }),
      ).toEqual({ visible: [], revealed: [] });
    }
  });
});

describe("collectUnreadActivityThreads", () => {
  it("holds unread snoozed threads out of the activity bell and read sweep", () => {
    const thread = {
      ...makeThread({
        id: "snoozed",
        latestTurn: completedTurn("2026-08-01T10:00:00.000Z"),
        lastVisitedAt: "2026-08-01T09:00:00.000Z",
      }),
      snoozedUntil: "2026-08-01T08:00:00.000Z",
    };
    expect(collectUnreadActivityThreads([thread])).toEqual([]);
    expect(hasActivityNeedingAttention([thread], null, (row) => tierOf(row))).toBe(false);
  });

  it("collects only eligible threads with unseen completions", () => {
    const unread = makeThread({
      id: "unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const read = makeThread({
      id: "read",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    const archivedUnread = makeThread({
      id: "archived",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
      archivedAt: "2026-08-01T10:00:00.000Z",
    });

    expect(collectUnreadActivityThreads([unread, read, archivedUnread]).map((t) => t.id)).toEqual([
      "unread",
    ]);
  });

  it("reads a chat back from snooze at the reminder, or at a later completion", () => {
    const returned = {
      ...makeThread({
        id: "returned",
        latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
        lastVisitedAt: "2026-08-01T09:45:00.000Z",
      }),
      snoozedUntil: null,
      snoozeReminderAt: "2026-08-01T11:00:00.000Z",
    };
    // A turn left running when the chat was snoozed can finish after the reminder.
    const finishedLater = { ...returned, latestTurn: completedTurn("2026-08-01T11:30:00.000Z") };

    expect(resolveActivityThreadReadAt(returned)).toBe("2026-08-01T11:00:00.000Z");
    expect(resolveActivityThreadReadAt(finishedLater)).toBe("2026-08-01T11:30:00.000Z");
  });

  it("does not light the bell for the thread currently being read", () => {
    const activeUnread = makeThread({
      id: "active-unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const otherUnread = makeThread({
      id: "other-unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });

    const tier = (row: SidebarThreadSummary) => tierOf(row);
    expect(hasActivityNeedingAttention([activeUnread], activeUnread.id, tier)).toBe(false);
    expect(hasActivityNeedingAttention([activeUnread, otherUnread], activeUnread.id, tier)).toBe(
      true,
    );
  });

  it("lights the bell for waiting threads but not for work that is only running", () => {
    const tier = (row: SidebarThreadSummary) => tierOf(row);
    const approval = makeThread({
      id: "approval",
      hasPendingApprovals: true,
      latestTurn: completedTurn("2026-08-01T09:00:00.000Z"),
    });
    const running = makeThread({
      id: "running",
      hasLiveTailWork: true,
      latestHumanMessageAt: "2026-08-01T09:00:00.000Z",
    });
    expect(hasActivityNeedingAttention([approval], null, tier)).toBe(true);
    expect(hasActivityNeedingAttention([running], null, tier)).toBe(false);
    const status = resolveThreadStatusPill({
      thread: approval,
      hasPendingApprovals: true,
      hasPendingUserInput: false,
    });
    expect(
      hasActivityNeedingAttention([approval], null, (row) => tierOf(row, status?.dismissalKey)),
    ).toBe(false);
  });
});

describe("findNextThreadNeedingAttention", () => {
  const tier = (row: SidebarThreadSummary) => tierOf(row);
  const unreadAt = (id: string, latestHumanMessageAt: string) =>
    makeThread({
      id,
      latestHumanMessageAt,
      latestTurn: completedTurn("2026-08-01T11:00:00.000Z"),
      lastVisitedAt: "2026-08-01T10:00:00.000Z",
    });

  it("cycles through all actionable chats before wrapping and skips the sole open chat", () => {
    const newerUnread = unreadAt("newer-unread", "2026-08-01T10:30:00.000Z");
    const olderWaiting = makeThread({
      id: "older-waiting",
      hasPendingUserInput: true,
      latestHumanMessageAt: "2026-08-01T08:00:00.000Z",
      latestTurn: completedTurn("2026-08-01T08:00:00.000Z"),
    });
    const newerWaiting = makeThread({
      id: "newer-waiting",
      hasPendingApprovals: true,
      latestHumanMessageAt: "2026-08-01T09:00:00.000Z",
      latestTurn: completedTurn("2026-08-01T09:00:00.000Z"),
    });
    const running = makeThread({
      id: "running",
      hasLiveTailWork: true,
      latestHumanMessageAt: "2026-08-01T11:00:00.000Z",
    });
    const threads = [newerUnread, olderWaiting, newerWaiting, running];
    expect(findNextThreadNeedingAttention(threads, null, tier)).toBe("newer-waiting");
    expect(findNextThreadNeedingAttention(threads, newerWaiting.id, tier)).toBe("older-waiting");
    expect(findNextThreadNeedingAttention(threads, olderWaiting.id, tier)).toBe("newer-unread");
    expect(findNextThreadNeedingAttention(threads, newerUnread.id, tier)).toBe("newer-waiting");
    expect(findNextThreadNeedingAttention([newerWaiting], newerWaiting.id, tier)).toBeNull();
    expect(findNextThreadNeedingAttention([newerUnread, running], null, tier)).toBe("newer-unread");
  });

  it("skips snoozed, archived, and running-only threads", () => {
    const snoozed = {
      ...unreadAt("snoozed", "2026-08-01T10:00:00.000Z"),
      snoozedUntil: "2026-08-02T09:00:00.000Z",
    };
    const archived = makeThread({
      id: "archived",
      hasPendingApprovals: true,
      latestTurn: completedTurn("2026-08-01T09:00:00.000Z"),
      archivedAt: "2026-08-01T10:00:00.000Z",
    });
    const running = makeThread({ id: "running", hasLiveTailWork: true });
    expect(findNextThreadNeedingAttention([snoozed, archived, running], null, tier)).toBeNull();
  });
});
