import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";

import type { SidebarThreadSummary, ThreadSession } from "../types";
import { resolveThreadProjectLabel } from "./Sidebar.logic";
import {
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityThreads,
  collectVisibleActivityThreadIds,
  groupActivityThreadsByProject,
  hasUnreadActivity,
  isActivityThread,
  resolveActivityDateBucket,
  resolveActivityScope,
  type ActivityScopeOption,
  splitActivityThreadsByDateBucket,
  splitRecentActivityThreads,
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

describe("isActivityThread", () => {
  it("excludes archived, subagent, and never-run threads", () => {
    expect(isActivityThread(makeThread({ id: "a", archivedAt: "2026-08-01T00:00:00Z" }))).toBe(
      false,
    );
    expect(isActivityThread(makeThread({ id: "b", parentThreadId: "parent" }))).toBe(false);
    expect(isActivityThread(makeThread({ id: "c", latestTurn: null }))).toBe(false);
  });

  it("includes threads whose first turn is starting", () => {
    expect(isActivityThread(makeThread({ id: "d", latestTurn: null, hasLiveTailWork: true }))).toBe(
      true,
    );
  });

  it("includes threads that ran at least once", () => {
    expect(
      isActivityThread(
        makeThread({ id: "e", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      ),
    ).toBe(true);
  });
});

describe("buildActivityViewModel", () => {
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

  it("keeps attention rows ordered by human sends instead of approval timestamps", () => {
    const pendingApproval = (id: string, startedAt: string, updatedAt: string) =>
      makeThread({
        id,
        createdAt: "2026-08-01T04:00:00.000Z",
        updatedAt,
        latestHumanMessageAt: startedAt,
        hasPendingApprovals: true,
        session: makeSession("running"),
        latestTurn: {
          turnId: `turn-${id}`,
          state: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
        } as SidebarThreadSummary["latestTurn"],
      });
    const olderTurnWithNewerApproval = pendingApproval(
      "older-turn-newer-approval",
      "2026-08-01T09:00:00.000Z",
      "2026-08-01T09:30:00.000Z",
    );
    const newerTurnWithOlderApproval = pendingApproval(
      "newer-turn-older-approval",
      "2026-08-01T09:15:00.000Z",
      "2026-08-01T09:20:00.000Z",
    );

    const model = buildActivityViewModel({
      threads: [newerTurnWithOlderApproval, olderTurnWithNewerApproval],
      pinnedThreadIdSet: new Set(),
    });

    expect(model.active.map((thread) => thread.id)).toEqual([
      "newer-turn-older-approval",
      "older-turn-newer-approval",
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

  it("filters to the selected project", () => {
    expect(resolveActivityScope(PROJECT_ID, options)).toEqual({
      scope: PROJECT_ID,
      projectFilterIds: new Set([PROJECT_ID]),
    });
  });

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

describe("splitRecentActivityThreads", () => {
  // Fixed "now": 2026-08-01T15:00 local time, so the working day started at 04:00.
  const recentNowMs = new Date(2026, 7, 1, 15, 0, 0).getTime();
  const localIso = (year: number, month: number, day: number, hour: number) =>
    new Date(year, month, day, hour).toISOString();
  const byInteraction = (id: string, latestHumanMessageAt: string, lastVisitedAt?: string) => ({
    ...makeThread({
      id,
      latestTurn: completedTurn(latestHumanMessageAt),
      ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
    }),
    latestHumanMessageAt,
  });

  it("caps at the limit and ignores newer visits when ordering human sends", () => {
    const active = [
      byInteraction("a", localIso(2026, 7, 1, 10)),
      byInteraction("b", localIso(2026, 7, 1, 12)),
      // Opening an older chat must not move it above newer human sends.
      byInteraction("c", localIso(2026, 7, 1, 8), localIso(2026, 7, 1, 13)),
      byInteraction("d", localIso(2026, 7, 1, 9)),
    ];

    const { recent, rest } = splitRecentActivityThreads(active, { nowMs: recentNowMs, limit: 2 });
    expect(recent.map((thread) => thread.id)).toEqual(["b", "a"]);
    expect(rest.map((thread) => thread.id)).toEqual(["c", "d"]);
  });

  it("ages threads last touched before today out of Recent, into the date buckets", () => {
    const active = [
      byInteraction("today", localIso(2026, 7, 1, 9)),
      byInteraction("two-days-ago", localIso(2026, 6, 30, 14)),
      // Yesterday evening, past midnight but before the 4am turnover: still stale.
      byInteraction("last-night", localIso(2026, 6, 31, 23)),
    ];

    const { recent, rest } = splitRecentActivityThreads(active, { nowMs: recentNowMs });
    expect(recent.map((thread) => thread.id)).toEqual(["today"]);
    expect(rest.map((thread) => thread.id)).toEqual(["two-days-ago", "last-night"]);
  });

  it("carries a past-midnight session as the same working day until 4am", () => {
    // 01:30 local: the working day still starts at 04:00 on the previous date.
    const afterMidnightMs = new Date(2026, 7, 2, 1, 30, 0).getTime();
    const active = [
      byInteraction("late-night", localIso(2026, 7, 1, 23)),
      byInteraction("previous-day", localIso(2026, 7, 1, 3)),
    ];

    const { recent, rest } = splitRecentActivityThreads(active, { nowMs: afterMidnightMs });
    expect(recent.map((thread) => thread.id)).toEqual(["late-night"]);
    expect(rest.map((thread) => thread.id)).toEqual(["previous-day"]);
  });

  it("keeps never-touched threads out of Recent", () => {
    const untouched = {
      ...makeThread({ id: "untouched", latestTurn: completedTurn(localIso(2026, 7, 1, 9)) }),
      lastVisitedAt: undefined,
      latestUserMessageAt: null,
    };
    const { recent, rest } = splitRecentActivityThreads([untouched], { nowMs: recentNowMs });
    expect(recent).toEqual([]);
    expect(rest.map((thread) => thread.id)).toEqual(["untouched"]);
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
        recent: [thread("recent")],
        today: [thread("today")],
        yesterday: [thread("yesterday")],
        earlierOpen: true,
        earlier: [thread("earlier-visible")],
        projectGroups: [],
        settledOpen: false,
        settled: [thread("done")],
      }),
    ).toEqual(["recent", "today", "yesterday", "earlier-visible"]);
  });

  it("uses already-paged project groups in project mode", () => {
    const thread = (id: string) => makeThread({ id });
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "project",
        pinnedOpen: true,
        pinned: [thread("pinned")],
        recent: [],
        today: [],
        yesterday: [],
        earlierOpen: false,
        earlier: [],
        projectGroups: [[thread("project-a")], [thread("project-b")]],
        settledOpen: true,
        settled: [thread("done")],
      }),
    ).toEqual(["pinned", "project-a", "project-b", "done"]);
  });

  it("deduplicates a pinned unread thread that also appears in Recent", () => {
    const duplicated = makeThread({ id: "pinned-unread" });
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "time",
        pinnedOpen: true,
        pinned: [duplicated],
        recent: [],
        today: [],
        yesterday: [],
        earlierOpen: false,
        earlier: [],
        projectGroups: [],
        settledOpen: false,
        settled: [],
      }),
    ).toEqual([duplicated.id]);
  });
});

describe("collectUnreadActivityThreads", () => {
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

    expect(hasUnreadActivity([activeUnread], activeUnread.id)).toBe(false);
    expect(hasUnreadActivity([activeUnread, otherUnread], activeUnread.id)).toBe(true);
  });
});

describe("resolveThreadProjectLabel", () => {
  it("preserves real project names, including Synara, and falls back to the folder name", () => {
    expect(
      resolveThreadProjectLabel({ kind: "project", name: "  Synara  ", folderName: "synara" }),
    ).toBe("Synara");
    expect(
      resolveThreadProjectLabel({ kind: "project", name: "  ", folderName: "repository" }),
    ).toBe("repository");
  });

  it.each(["chat", "studio"] as const)("labels %s containers as No project", (kind) => {
    expect(
      resolveThreadProjectLabel({ kind, name: "Home", folderName: "generated-chat-slug" }),
    ).toBe("No project");
  });

  it("does not invent a project name while project metadata is unavailable", () => {
    expect(resolveThreadProjectLabel(null)).toBe("No project");
    expect(resolveThreadProjectLabel(undefined)).toBe("No project");
  });
});
