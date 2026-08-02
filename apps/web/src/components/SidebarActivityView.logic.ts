// FILE: SidebarActivityView.logic.ts
// Purpose: Pure grouping/sorting model for the sidebar Activity view (threads as tasks).
// Exports: eligibility, status-group resolution, settle helpers, and the view-model builder.

import type { ProjectId, ThreadId } from "@synara/contracts";

import { formatRelativeTime } from "~/lib/relativeTime";
import type { TimestampFormat } from "../appSettings";
import { canSessionAnswerPendingRequests, isLatestTurnSettled } from "../session-logic";
import { formatShortTimestamp } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { hasUnseenCompletion, isThreadActivelyWorking } from "./Sidebar.logic";

/**
 * Task-feed ordering, top to bottom: threads that need the user (approvals,
 * input, ready plans), finished work not yet seen, live work, then everything
 * already reviewed. Settled threads leave these groups entirely and sink to
 * the dimmed Settled section.
 */
export type ActivityStatusGroup = "attention" | "unseenCompleted" | "running" | "seen";

const ACTIVITY_GROUP_ORDER: Record<ActivityStatusGroup, number> = {
  attention: 0,
  unseenCompleted: 1,
  running: 2,
  seen: 3,
};

export function isThreadRunningForActivity(
  thread: Pick<SidebarThreadSummary, "hasLiveTailWork" | "session" | "latestTurn">,
): boolean {
  return isThreadActivelyWorking(thread) || thread.session?.status === "connecting";
}

export function resolveActivityStatusGroup(thread: SidebarThreadSummary): ActivityStatusGroup {
  // Mirrors resolveThreadStatusPill: a dead session cannot receive answers, so
  // its pending requests no longer count as "needs attention".
  const canAnswerPendingRequests = canSessionAnswerPendingRequests(thread.session);
  if ((thread.hasPendingApprovals || thread.hasPendingUserInput) && canAnswerPendingRequests) {
    return "attention";
  }
  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    !thread.hasLiveTailWork &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return "attention";
  }
  if (isThreadRunningForActivity(thread)) {
    return "running";
  }
  if (hasUnseenCompletion(thread)) {
    return "unseenCompleted";
  }
  return "seen";
}

/**
 * Threads that belong in the task feed: top-level, not archived, and having run
 * at least once. Drafts stay out, but a thread whose very first turn is
 * starting up already counts as running work.
 */
export function isActivityThread(thread: SidebarThreadSummary): boolean {
  if (thread.archivedAt != null) return false;
  if (thread.parentThreadId) return false;
  return thread.latestTurn !== null || isThreadRunningForActivity(thread);
}

export function isThreadSettledForActivity(
  thread: Pick<SidebarThreadSummary, "id" | "settledAt">,
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>,
): boolean {
  return settledOverrideByThreadId?.get(thread.id) ?? thread.settledAt != null;
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function resolveActivityRecencyMs(
  thread: Pick<SidebarThreadSummary, "updatedAt" | "createdAt">,
): number {
  return parseTimestampMs(thread.updatedAt ?? thread.createdAt);
}

export interface ActivityViewModel {
  pinned: SidebarThreadSummary[];
  active: SidebarThreadSummary[];
  settled: SidebarThreadSummary[];
}

/**
 * Splits eligible threads into the three Activity sections and orders each:
 * pinned by recency, active by status group then recency, settled by when they
 * were settled. Settling wins over pinning — an explicitly settled thread sinks
 * to the Settled section even while it stays pinned. An optional project filter
 * narrows every section without changing the ordering rules.
 */
export function buildActivityViewModel(input: {
  threads: readonly SidebarThreadSummary[];
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  /** Project scope as a set so merged scopes (all project-less chats) filter as one. */
  projectFilterIds?: ReadonlySet<ProjectId> | null;
}): ActivityViewModel {
  const projectFilterIds = input.projectFilterIds ?? null;
  const pinned: SidebarThreadSummary[] = [];
  const active: SidebarThreadSummary[] = [];
  const settled: SidebarThreadSummary[] = [];

  for (const thread of input.threads) {
    if (!isActivityThread(thread)) continue;
    if (projectFilterIds !== null && !projectFilterIds.has(thread.projectId)) continue;
    // Pinned threads live exclusively in the compact Pinned section above the
    // feed (classic sidebar behavior), so they leave every feed bucket.
    if (input.pinnedThreadIdSet.has(thread.id)) {
      pinned.push(thread);
    } else if (isThreadSettledForActivity(thread, input.settledOverrideByThreadId)) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  pinned.sort((left, right) => resolveActivityRecencyMs(right) - resolveActivityRecencyMs(left));
  active.sort((left, right) => {
    const groupDelta =
      ACTIVITY_GROUP_ORDER[resolveActivityStatusGroup(left)] -
      ACTIVITY_GROUP_ORDER[resolveActivityStatusGroup(right)];
    if (groupDelta !== 0) return groupDelta;
    return resolveActivityRecencyMs(right) - resolveActivityRecencyMs(left);
  });
  settled.sort((left, right) => {
    // Optimistically settled threads have no settledAt yet; their latest
    // activity stands in so they surface at the top of the section.
    const leftSettledMs = parseTimestampMs(left.settledAt) || resolveActivityRecencyMs(left);
    const rightSettledMs = parseTimestampMs(right.settledAt) || resolveActivityRecencyMs(right);
    return rightSettledMs - leftSettledMs;
  });

  return { pinned, active, settled };
}

const DAY_MS = 86_400_000;

export type ActivityDateBucket = "today" | "yesterday" | "earlier";

export function resolveActivityDateBucket(
  thread: Pick<SidebarThreadSummary, "updatedAt" | "createdAt">,
  nowMs: number,
): ActivityDateBucket {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const recencyMs = resolveActivityRecencyMs(thread);
  if (recencyMs >= startOfToday.getTime()) return "today";
  if (recencyMs >= startOfToday.getTime() - DAY_MS) return "yesterday";
  return "earlier";
}

/**
 * Splits an already-ordered active list into calendar sections. Ordering is
 * preserved as-is inside each bucket, so status priority keeps working within
 * a day and the Earlier section can collapse the long tail.
 */
export function splitActivityThreadsByDateBucket(
  threads: readonly SidebarThreadSummary[],
  nowMs: number,
): Record<ActivityDateBucket, SidebarThreadSummary[]> {
  const buckets: Record<ActivityDateBucket, SidebarThreadSummary[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const thread of threads) {
    buckets[resolveActivityDateBucket(thread, nowMs)].push(thread);
  }
  return buckets;
}

/** How the feed lays out its sections: calendar buckets or one block per project. */
export type ActivityGroupMode = "time" | "project";

export interface ActivityProjectGroup {
  projectId: ProjectId;
  threads: SidebarThreadSummary[];
}

/**
 * Groups an already-ordered active list by project, busiest-recent project
 * first. Thread order inside a group is preserved, so status priority still
 * decides who leads each project block.
 */
export function groupActivityThreadsByProject(
  threads: readonly SidebarThreadSummary[],
): ActivityProjectGroup[] {
  const groupByProjectId = new Map<ProjectId, SidebarThreadSummary[]>();
  for (const thread of threads) {
    const group = groupByProjectId.get(thread.projectId);
    if (group) {
      group.push(thread);
    } else {
      groupByProjectId.set(thread.projectId, [thread]);
    }
  }
  return Array.from(groupByProjectId, ([projectId, groupThreads]) => ({
    projectId,
    threads: groupThreads,
  })).toSorted(
    (left, right) =>
      Math.max(...right.threads.map(resolveActivityRecencyMs)) -
      Math.max(...left.threads.map(resolveActivityRecencyMs)),
  );
}

export type ActivityScopeOption =
  | { kind: "project"; projectId: ProjectId; threadCount: number }
  | { kind: "chats"; projectIds: ProjectId[]; threadCount: number };

/**
 * Scope menu entries: every real project with eligible activity, busiest first.
 * Project-less chats (chat/studio-kind containers) collapse into ONE "Synara"
 * entry instead of one look-alike row per hidden container project.
 */
export function collectActivityScopeOptions(
  threads: readonly SidebarThreadSummary[],
  isRealProject: (projectId: ProjectId) => boolean,
): ActivityScopeOption[] {
  const countByProjectId = new Map<ProjectId, number>();
  for (const thread of threads) {
    if (!isActivityThread(thread)) continue;
    countByProjectId.set(thread.projectId, (countByProjectId.get(thread.projectId) ?? 0) + 1);
  }

  const options: ActivityScopeOption[] = [];
  const chatProjectIds: ProjectId[] = [];
  let chatThreadCount = 0;
  for (const [projectId, threadCount] of countByProjectId) {
    if (isRealProject(projectId)) {
      options.push({ kind: "project", projectId, threadCount });
    } else {
      chatProjectIds.push(projectId);
      chatThreadCount += threadCount;
    }
  }
  if (chatProjectIds.length > 0) {
    options.push({ kind: "chats", projectIds: chatProjectIds, threadCount: chatThreadCount });
  }
  return options.toSorted((left, right) => right.threadCount - left.threadCount);
}

/** The project scope the feed is pinned to, or null for every project. */
export type ActivityScopeSelection = ProjectId | "chats" | null;

/**
 * The scope the feed can actually honor. A selection whose option has left the
 * menu — its last thread was archived, settled away, or moved — falls back to
 * "all projects" instead of filtering the feed down to nothing behind a scope
 * the user can no longer see.
 */
export function resolveActivityScope(
  scopeSelection: ActivityScopeSelection,
  scopeOptions: readonly ActivityScopeOption[],
): { scope: ActivityScopeSelection; projectFilterIds: Set<ProjectId> | null } {
  if (scopeSelection === null) return { scope: null, projectFilterIds: null };
  if (scopeSelection === "chats") {
    const chats = scopeOptions.find((option) => option.kind === "chats");
    if (!chats) return { scope: null, projectFilterIds: null };
    return { scope: "chats", projectFilterIds: new Set(chats.projectIds) };
  }
  const isOffered = scopeOptions.some(
    (option) => option.kind === "project" && option.projectId === scopeSelection,
  );
  if (!isOffered) return { scope: null, projectFilterIds: null };
  return { scope: scopeSelection, projectFilterIds: new Set([scopeSelection]) };
}

export const ACTIVITY_RECENT_LIMIT = 5;

/**
 * When the user last touched a thread themselves: opened it (lastVisitedAt) or
 * sent a message (latestUserMessageAt). Agent/automation activity deliberately
 * does not count — the Recent section tracks the user's working set, not the
 * server's.
 */
export function resolveActivityInteractionMs(
  thread: Pick<SidebarThreadSummary, "lastVisitedAt" | "latestUserMessageAt">,
): number {
  return Math.max(
    parseTimestampMs(thread.lastVisitedAt),
    parseTimestampMs(thread.latestUserMessageAt),
  );
}

/**
 * Pulls the user's working set out of the (already status-sorted) active list:
 * the last `limit` threads they interacted with, newest interaction first. The
 * remainder keeps its original order for the date buckets below.
 */
export function splitRecentActivityThreads(
  active: readonly SidebarThreadSummary[],
  limit: number = ACTIVITY_RECENT_LIMIT,
): { recent: SidebarThreadSummary[]; rest: SidebarThreadSummary[] } {
  const recent = active
    .filter((thread) => resolveActivityInteractionMs(thread) > 0)
    .toSorted(
      (left, right) => resolveActivityInteractionMs(right) - resolveActivityInteractionMs(left),
    )
    .slice(0, limit);
  const recentThreadIds = new Set(recent.map((thread) => thread.id));
  return {
    recent,
    rest: active.filter((thread) => !recentThreadIds.has(thread.id)),
  };
}

/**
 * Row timestamp: today's threads show the exact clock time (task-feed precision,
 * and it disambiguates same-title chats that would both read "2h"); older rows
 * keep the coarser relative label.
 */
export function formatActivityRowTime(input: {
  thread: Pick<SidebarThreadSummary, "updatedAt" | "createdAt">;
  nowMs: number;
  timestampFormat: TimestampFormat;
}): string {
  const isoDate = input.thread.updatedAt ?? input.thread.createdAt;
  if (resolveActivityDateBucket(input.thread, input.nowMs) === "today") {
    return formatShortTimestamp(isoDate, input.timestampFormat);
  }
  return formatRelativeTime(isoDate);
}

/** Threads "Mark all as read" should visit: eligible feed rows with an unseen completion. */
export function collectUnreadActivityThreads(
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  return threads.filter((thread) => isActivityThread(thread) && hasUnseenCompletion(thread));
}
