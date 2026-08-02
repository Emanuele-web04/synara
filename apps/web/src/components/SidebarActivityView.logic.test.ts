import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";

import type { SidebarThreadSummary, ThreadSession } from "../types";
import { formatRelativeTime } from "~/lib/relativeTime";
import { formatShortTimestamp } from "../timestampFormat";
import { resolveThreadProjectLabel } from "./Sidebar.logic";
import {
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityThreads,
  collectVisibleActivityThreadIds,
  formatActivityRowTime,
  groupActivityThreadsByProject,
  hasUnreadActivity,
  isActivityThread,
  resolveActivityDateBucket,
  resolveActivityScope,
  resolveActivityStatusGroup,
  type ActivityScopeOption,
  splitActivityThreadsByDateBucket,
  splitPriorityActivityThreads,
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
  updatedAt?: string;
  latestTurn?: SidebarThreadSummary["latestTurn"];
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
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-01T10:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    settledAt: input.settledAt ?? null,
    isPinned: input.isPinned ?? false,
    latestTurn: input.latestTurn ?? null,
    lastVisitedAt: input.lastVisitedAt,
    parentThreadId: input.parentThreadId ? ThreadId.makeUnsafe(input.parentThreadId) : null,
    latestUserMessageAt: null,
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

describe("resolveActivityStatusGroup", () => {
  it("puts answerable pending approvals in attention", () => {
    const thread = makeThread({
      id: "a",
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    expect(resolveActivityStatusGroup(thread)).toBe("attention");
  });

  it("ignores pending requests on dead sessions", () => {
    const thread = makeThread({
      id: "b",
      hasPendingApprovals: true,
      session: makeSession("closed"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    expect(resolveActivityStatusGroup(thread)).toBe("seen");
  });

  it("classifies live work as running", () => {
    const thread = makeThread({ id: "c", hasLiveTailWork: true });
    expect(resolveActivityStatusGroup(thread)).toBe("running");
  });

  it("classifies unseen completions", () => {
    const thread = makeThread({
      id: "d",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    expect(resolveActivityStatusGroup(thread)).toBe("unseenCompleted");
  });

  it("classifies visited completions as seen", () => {
    const thread = makeThread({
      id: "e",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    expect(resolveActivityStatusGroup(thread)).toBe("seen");
  });
});

describe("buildActivityViewModel", () => {
  it("orders active threads attention → unseen → running → seen, newest first per group", () => {
    const seenOld = makeThread({
      id: "seen-old",
      updatedAt: "2026-08-01T08:00:00.000Z",
      latestTurn: completedTurn("2026-08-01T07:30:00.000Z"),
      lastVisitedAt: "2026-08-01T07:45:00.000Z",
    });
    const seenNew = makeThread({
      id: "seen-new",
      updatedAt: "2026-08-01T09:00:00.000Z",
      latestTurn: completedTurn("2026-08-01T08:30:00.000Z"),
      lastVisitedAt: "2026-08-01T08:45:00.000Z",
    });
    const running = makeThread({
      id: "running",
      updatedAt: "2026-08-01T07:00:00.000Z",
      hasLiveTailWork: true,
      latestTurn: completedTurn("2026-08-01T06:30:00.000Z"),
    });
    const unseen = makeThread({
      id: "unseen",
      updatedAt: "2026-08-01T06:00:00.000Z",
      latestTurn: completedTurn("2026-08-01T05:30:00.000Z"),
      lastVisitedAt: "2026-08-01T05:00:00.000Z",
    });
    const attention = makeThread({
      id: "attention",
      updatedAt: "2026-08-01T05:00:00.000Z",
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T04:30:00.000Z"),
    });

    const model = buildActivityViewModel({
      threads: [seenOld, seenNew, running, unseen, attention],
      pinnedThreadIdSet: new Set(),
    });

    expect(model.active.map((thread) => thread.id)).toEqual([
      "attention",
      "unseen",
      "running",
      "seen-new",
      "seen-old",
    ]);
  });

  it("keeps every pinned thread exclusively in the Pinned section", () => {
    const pinnedUnread = makeThread({
      id: "pinned-unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const pinnedSeen = makeThread({
      id: "pinned-seen",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    const pinnedSettledSeen = makeThread({
      id: "pinned-settled-seen",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
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

  it("promotes settled threads while work is live, actionable, or newly completed", () => {
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

    expect(model.active.map((thread) => thread.id)).toEqual(["attention", "unseen", "running"]);
    expect(model.settled.map((thread) => thread.id)).toEqual(["reviewed"]);
  });
});

describe("date buckets", () => {
  // Fixed "now": 2026-08-01T15:00 local time.
  const now = new Date(2026, 7, 1, 15, 0, 0);
  const nowMs = now.getTime();
  const localIso = (year: number, month: number, day: number, hour: number) =>
    new Date(year, month, day, hour).toISOString();

  it("classifies today, yesterday, and earlier by local calendar day", () => {
    expect(
      resolveActivityDateBucket({ updatedAt: localIso(2026, 7, 1, 9), createdAt: "" }, nowMs),
    ).toBe("today");
    expect(
      resolveActivityDateBucket({ updatedAt: localIso(2026, 6, 31, 23), createdAt: "" }, nowMs),
    ).toBe("yesterday");
    expect(
      resolveActivityDateBucket({ updatedAt: localIso(2026, 6, 30, 23), createdAt: "" }, nowMs),
    ).toBe("earlier");
  });

  it("shows clock time for today's rows and relative time otherwise", () => {
    const todayIso = localIso(2026, 7, 1, 9);
    const yesterdayIso = localIso(2026, 6, 31, 9);
    expect(
      formatActivityRowTime({
        thread: { updatedAt: todayIso, createdAt: "" },
        nowMs,
        timestampFormat: "24-hour",
      }),
    ).toBe(formatShortTimestamp(todayIso, "24-hour"));
    expect(
      formatActivityRowTime({
        thread: { updatedAt: yesterdayIso, createdAt: "" },
        nowMs,
        timestampFormat: "24-hour",
      }),
    ).toBe(formatRelativeTime(yesterdayIso));
  });

  it("splits an ordered list preserving order inside each bucket", () => {
    const todayA = makeThread({ id: "today-a", updatedAt: localIso(2026, 7, 1, 14) });
    const todayB = makeThread({ id: "today-b", updatedAt: localIso(2026, 7, 1, 8) });
    const yesterday = makeThread({ id: "yesterday", updatedAt: localIso(2026, 6, 31, 12) });
    const earlier = makeThread({ id: "earlier", updatedAt: localIso(2026, 6, 20, 12) });

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
        makeThread({ id: "project", projectId: PROJECT_ID }),
        makeThread({ id: "chat-a", projectId: CHAT_PROJECT_A }),
        makeThread({ id: "chat-b", projectId: CHAT_PROJECT_B }),
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
  it("keeps attention, unseen completions, and running work ahead of reviewed threads", () => {
    const attention = makeThread({
      id: "attention",
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const unseen = makeThread({
      id: "unseen",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const running = makeThread({ id: "running", hasLiveTailWork: true });
    const seen = makeThread({
      id: "seen",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });

    const split = splitPriorityActivityThreads([attention, unseen, running, seen]);
    expect(split.priority.map((thread) => thread.id)).toEqual([
      "attention",
      "unseen",
      "running",
    ]);
    expect(split.seen.map((thread) => thread.id)).toEqual(["seen"]);
  });

  it("caps at the limit, sorts by newest interaction, and removes picks from the rest", () => {
    const byInteraction = (id: string, lastVisitedAt: string, latestUserMessageAt?: string) => ({
      ...makeThread({
        id,
        latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
        lastVisitedAt,
      }),
      latestUserMessageAt: latestUserMessageAt ?? null,
    });
    const active = [
      byInteraction("a", "2026-08-01T10:00:00.000Z"),
      byInteraction("b", "2026-08-01T12:00:00.000Z"),
      // Older visit but newer user message: the message wins.
      byInteraction("c", "2026-08-01T08:00:00.000Z", "2026-08-01T13:00:00.000Z"),
      byInteraction("d", "2026-08-01T09:00:00.000Z"),
    ];

    const { recent, rest } = splitRecentActivityThreads(active, 2);
    expect(recent.map((thread) => thread.id)).toEqual(["c", "b"]);
    expect(rest.map((thread) => thread.id)).toEqual(["a", "d"]);
  });

  it("keeps never-touched threads out of Recent", () => {
    const untouched = {
      ...makeThread({ id: "untouched", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      lastVisitedAt: undefined,
      latestUserMessageAt: null,
    };
    const { recent, rest } = splitRecentActivityThreads([untouched]);
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
        priority: [thread("attention")],
        recent: [thread("recent")],
        today: [thread("today")],
        yesterday: [thread("yesterday")],
        earlierOpen: true,
        earlier: [thread("earlier-visible")],
        projectGroups: [],
        settledOpen: false,
        settled: [thread("done")],
      }),
    ).toEqual(["attention", "recent", "today", "yesterday", "earlier-visible"]);
  });

  it("uses already-paged project groups in project mode", () => {
    const thread = (id: string) => makeThread({ id });
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "project",
        pinnedOpen: true,
        pinned: [thread("pinned")],
        priority: [thread("ignored-priority")],
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
        priority: [duplicated],
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
  it("uses the project name for real projects and Synara otherwise", () => {
    expect(
      resolveThreadProjectLabel({ kind: "project", name: "Synara App", folderName: "synara" }),
    ).toBe("Synara App");
    expect(resolveThreadProjectLabel({ kind: "chat", name: "Chats", folderName: "chats" })).toBe(
      "Synara",
    );
    expect(resolveThreadProjectLabel(undefined)).toBe("Synara");
  });
});
