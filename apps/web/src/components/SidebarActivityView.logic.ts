import { resolveActivityDayStartMs } from "@synara/shared/inboxDay";
export { resolveActivityDayStartMs } from "@synara/shared/inboxDay";
// FILE: SidebarActivityView.logic.ts
// Purpose: Pure grouping/sorting model for the sidebar Activity view (threads as tasks).
// Exports: eligibility, stable ordering, settle helpers, and the view-model builder.

import type { ProjectId, ThreadId } from "@synara/contracts";
import type { SidebarThreadSummary } from "../types";
import {
  hasUnseenCompletion,
  hasUnseenSnoozeReturn,
  isThreadActivelyWorking,
} from "./Sidebar.logic";

export function isThreadRunningForActivity(
  thread: Pick<SidebarThreadSummary, "hasLiveTailWork" | "session" | "latestTurn">,
): boolean {
  return isThreadActivelyWorking(thread) || thread.session?.status === "connecting";
}

/**
 * Threads that belong in the task feed: top-level, not archived, and having run
 * at least once, or explicitly snoozed/reminded. Ordinary drafts stay out,
 * but a thread whose very first turn is starting up already counts as work.
 */
export function isActivityThread(thread: SidebarThreadSummary): boolean {
  if (thread.archivedAt != null) return false;
  if (thread.parentThreadId) return false;
  return (
    thread.snoozedUntil != null ||
    thread.snoozeReminderAt != null ||
    thread.latestTurn !== null ||
    isThreadRunningForActivity(thread)
  );
}

export function isThreadSettledForActivity(
  thread: Pick<SidebarThreadSummary, "id" | "settledAt" | "latestHumanMessageAt">,
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>,
): boolean {
  const override = settledOverrideByThreadId?.get(thread.id);
  if (override !== undefined) return override;
  return (
    thread.settledAt != null &&
    parseTimestampMs(thread.latestHumanMessageAt) <= parseTimestampMs(thread.settledAt)
  );
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Human sends and intentional reminder wakeups move rows; background work and reads do not. */
export type ActivityRecencyInput = Pick<
  SidebarThreadSummary,
  "createdAt" | "latestHumanMessageAt" | "snoozeReminderAt"
>;

export function resolveActivityRecencyIso(thread: ActivityRecencyInput): string {
  if (parseTimestampMs(thread.snoozeReminderAt) > parseTimestampMs(thread.latestHumanMessageAt)) {
    return thread.snoozeReminderAt!;
  }
  return thread.latestHumanMessageAt && parseTimestampMs(thread.latestHumanMessageAt) > 0
    ? thread.latestHumanMessageAt
    : thread.createdAt;
}

export function resolveActivityRecencyMs(thread: ActivityRecencyInput): number {
  return parseTimestampMs(resolveActivityRecencyIso(thread));
}

/**
 * Last resort so equal timestamps still produce one fixed order: without it the
 * rows would follow whatever order the incoming thread list happened to have on
 * that render, which is exactly the flicker this sort is meant to prevent.
 */
function compareThreadIds(
  left: Pick<SidebarThreadSummary, "id">,
  right: Pick<SidebarThreadSummary, "id">,
): number {
  return left.id.localeCompare(right.id);
}

export interface ActivityViewModel {
  pinned: SidebarThreadSummary[];
  /** Unpinned chats with an unsent composer message; they lead the feed until sent or cleared. */
  drafts: SidebarThreadSummary[];
  active: SidebarThreadSummary[];
  settled: SidebarThreadSummary[];
  snoozed: SidebarThreadSummary[];
}

/**
 * Pinned, draft, and active rows follow human sends; explicitly settled rows keep
 * settlement order. Pinned drafts stay pinned but lead that section.
 */
export function buildActivityViewModel(input: {
  threads: readonly SidebarThreadSummary[];
  pinnedThreadIdSet: ReadonlySet<ThreadId>;
  draftThreadIdSet?: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  /** Project scope as a set so merged scopes (all project-less chats) filter as one. */
  projectFilterIds?: ReadonlySet<ProjectId> | null;
}): ActivityViewModel {
  const projectFilterIds = input.projectFilterIds ?? null;
  const draftThreadIdSet = input.draftThreadIdSet ?? null;
  const pinned: SidebarThreadSummary[] = [];
  const drafts: SidebarThreadSummary[] = [];
  const active: SidebarThreadSummary[] = [];
  const settled: SidebarThreadSummary[] = [];
  const snoozed: SidebarThreadSummary[] = [];

  for (const thread of input.threads) {
    if (!isActivityThread(thread)) continue;
    if (projectFilterIds !== null && !projectFilterIds.has(thread.projectId)) continue;
    // The server clears snooze on expiry. Client clocks must not surface a thread
    // before that durable update, and pins cannot bypass the user's snooze.
    if (thread.snoozedUntil != null) {
      snoozed.push(thread);
      continue;
    }
    if (input.pinnedThreadIdSet.has(thread.id)) {
      pinned.push(thread);
      continue;
    }
    if (draftThreadIdSet?.has(thread.id)) {
      drafts.push(thread);
      continue;
    }
    if (isThreadSettledForActivity(thread, input.settledOverrideByThreadId)) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  const compareRecency = (left: SidebarThreadSummary, right: SidebarThreadSummary) =>
    resolveActivityRecencyMs(right) - resolveActivityRecencyMs(left) ||
    compareThreadIds(left, right);
  const isDraft = (thread: SidebarThreadSummary) => draftThreadIdSet?.has(thread.id) ?? false;
  pinned.sort(
    (left, right) => Number(isDraft(right)) - Number(isDraft(left)) || compareRecency(left, right),
  );
  drafts.sort(compareRecency);
  active.sort(compareRecency);
  settled.sort((left, right) => {
    // Optimistically settled threads have no settledAt yet; their latest
    // activity stands in so they surface at the top of the section.
    const leftSettledMs = parseTimestampMs(left.settledAt) || resolveActivityRecencyMs(left);
    const rightSettledMs = parseTimestampMs(right.settledAt) || resolveActivityRecencyMs(right);
    return rightSettledMs - leftSettledMs || compareThreadIds(left, right);
  });

  snoozed.sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil) - parseTimestampMs(right.snoozedUntil) ||
      compareThreadIds(left, right),
  );
  return { pinned, drafts, active, settled, snoozed };
}

export type ActivityDateBucket = "today" | "yesterday" | "earlier";

export function resolveActivityDateBucket(
  thread: ActivityRecencyInput,
  nowMs: number,
): ActivityDateBucket {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const recencyMs = resolveActivityRecencyMs(thread);
  if (recencyMs >= startOfToday.getTime()) return "today";
  if (recencyMs >= startOfYesterday.getTime()) return "yesterday";
  return "earlier";
}

/**
 * Splits an already-ordered active list into calendar sections. Ordering is
 * preserved inside each bucket; Earlier can collapse the long tail.
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

export type ActivityProjectGroup =
  | {
      key: string;
      kind: "project";
      projectId: ProjectId;
      threads: SidebarThreadSummary[];
    }
  | {
      key: "chats";
      kind: "chats";
      projectIds: ProjectId[];
      threads: SidebarThreadSummary[];
    };

/** Groups the feed by project, ordered by each project's most recent human send. */
export function groupActivityThreadsByProject(
  threads: readonly SidebarThreadSummary[],
  isRealProject: (projectId: ProjectId) => boolean,
): ActivityProjectGroup[] {
  const groupByKey = new Map<string, ActivityProjectGroup>();
  for (const thread of threads) {
    const key = isRealProject(thread.projectId) ? `project:${thread.projectId}` : "chats";
    const group = groupByKey.get(key);
    if (group) {
      group.threads.push(thread);
      if (group.kind === "chats" && !group.projectIds.includes(thread.projectId)) {
        group.projectIds.push(thread.projectId);
      }
      continue;
    }
    groupByKey.set(
      key,
      isRealProject(thread.projectId)
        ? {
            key,
            kind: "project",
            projectId: thread.projectId,
            threads: [thread],
          }
        : {
            key: "chats",
            kind: "chats",
            projectIds: [thread.projectId],
            threads: [thread],
          },
    );
  }
  // Precomputed so the comparator stays O(1) per call instead of rescanning
  // every thread of both groups on each comparison.
  const recencyByKey = new Map<string, number>();
  for (const group of groupByKey.values()) {
    let recencyMs = 0;
    for (const thread of group.threads) {
      recencyMs = Math.max(recencyMs, resolveActivityRecencyMs(thread));
    }
    recencyByKey.set(group.key, recencyMs);
  }

  return Array.from(groupByKey.values()).toSorted((left, right) => {
    return (
      recencyByKey.get(right.key)! - recencyByKey.get(left.key)! ||
      left.key.localeCompare(right.key)
    );
  });
}

export type ActivityScopeOption =
  | { kind: "project"; projectId: ProjectId; threadCount: number }
  | { kind: "chats"; projectIds: ProjectId[]; threadCount: number };

/**
 * Scope menu entries: every real project with eligible activity, busiest first.
 * Project-less chats (chat/group-kind containers) collapse into ONE "Synara"
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

/** The five most recent human sends or reminders in the current working day. */
export function splitRecentActivityThreads(
  active: readonly SidebarThreadSummary[],
  options: { nowMs: number; limit?: number },
): { recent: SidebarThreadSummary[]; rest: SidebarThreadSummary[] } {
  const limit = options.limit ?? ACTIVITY_RECENT_LIMIT;
  const dayStartMs = resolveActivityDayStartMs(options.nowMs);
  const recent = active
    .filter(
      (thread) =>
        resolveActivityRecencyMs(thread) >= dayStartMs &&
        (thread.latestHumanMessageAt != null || thread.snoozeReminderAt != null),
    )
    .toSorted(
      (left, right) =>
        resolveActivityRecencyMs(right) - resolveActivityRecencyMs(left) ||
        compareThreadIds(left, right),
    )
    .slice(0, limit);
  const recentThreadIds = new Set(recent.map((thread) => thread.id));
  return {
    recent,
    rest: active.filter((thread) => !recentThreadIds.has(thread.id)),
  };
}

/**
 * Rows a collapsible, paged Activity section mounts. The open thread is always
 * kept on screen, the way the classic project list reveals it past its page cap:
 * past the page it joins `visible`, and under a collapsed header it is returned
 * as `revealed` so the section can show it without expanding. Section state is
 * untouched, so the row drops back into place once another thread is opened.
 */
export function resolveActivitySectionRows<T extends Pick<SidebarThreadSummary, "id">>(
  rows: readonly T[],
  options: { open: boolean; previewLimit: number; activeThreadId: ThreadId | null },
): { visible: T[]; revealed: T[] } {
  const activeIndex =
    options.activeThreadId === null
      ? -1
      : rows.findIndex((thread) => thread.id === options.activeThreadId);
  if (!options.open) {
    const activeRow = rows[activeIndex];
    return { visible: [], revealed: activeRow ? [activeRow] : [] };
  }
  const visible = rows.slice(0, options.previewLimit);
  const activeRow = rows[activeIndex];
  if (activeRow && activeIndex >= options.previewLimit) visible.push(activeRow);
  return { visible, revealed: [] };
}

/**
 * Computes the rows that are actually mounted in Activity render order. The
 * Sidebar consumes this same list for jump shortcuts, next/previous navigation,
 * prewarming, and live PR refreshes so hidden classic-project state cannot leak
 * into the Activity surface.
 */
export function collectVisibleActivityThreadIds(input: {
  groupMode: ActivityGroupMode;
  pinnedOpen: boolean;
  pinned: readonly SidebarThreadSummary[];
  drafts: readonly SidebarThreadSummary[];
  recent: readonly SidebarThreadSummary[];
  today: readonly SidebarThreadSummary[];
  yesterday: readonly SidebarThreadSummary[];
  earlierOpen: boolean;
  earlier: readonly SidebarThreadSummary[];
  projectGroups: readonly (readonly SidebarThreadSummary[])[];
  settledOpen: boolean;
  settled: readonly SidebarThreadSummary[];
  /** The open thread shown under a collapsed header; mounted whatever the section state. */
  revealed?: {
    pinned: readonly SidebarThreadSummary[];
    earlier: readonly SidebarThreadSummary[];
    settled: readonly SidebarThreadSummary[];
  };
}): ThreadId[] {
  const visible: SidebarThreadSummary[] = [];
  if (input.pinnedOpen) visible.push(...input.pinned);
  if (input.revealed) visible.push(...input.revealed.pinned);
  if (input.groupMode === "project") {
    for (const group of input.projectGroups) visible.push(...group);
  } else {
    visible.push(...input.drafts, ...input.recent, ...input.today, ...input.yesterday);
    if (input.earlierOpen) visible.push(...input.earlier);
    if (input.revealed) visible.push(...input.revealed.earlier);
  }
  if (input.settledOpen) visible.push(...input.settled);
  if (input.revealed) visible.push(...input.revealed.settled);
  return [...new Set(visible.map((thread) => thread.id))];
}

/** Threads "Mark all as read" should visit: eligible feed rows with an unseen completion. */
export function collectUnreadActivityThreads(
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  return threads.filter(
    (thread) =>
      thread.snoozedUntil == null &&
      isActivityThread(thread) &&
      (hasUnseenCompletion(thread) || hasUnseenSnoozeReturn(thread)),
  );
}

/**
 * The visit that reads an activity thread: its latest completion, or the snooze reminder
 * when the chat came back from snooze after it. Like opening the chat, this uses the
 * server's reminder time rather than this device's clock.
 */
export function resolveActivityThreadReadAt(thread: SidebarThreadSummary): string | undefined {
  const completedAt = thread.latestTurn?.completedAt ?? undefined;
  const reminderAt = thread.snoozeReminderAt ?? undefined;
  if (reminderAt === undefined || !hasUnseenSnoozeReturn(thread)) return completedAt;
  return completedAt !== undefined && Date.parse(completedAt) > Date.parse(reminderAt)
    ? completedAt
    : reminderAt;
}

/** The open thread is already being read even if its visited timestamp update is one render late. */
export function hasUnreadActivity(
  threads: readonly SidebarThreadSummary[],
  activeThreadId: ThreadId | null,
): boolean {
  return collectUnreadActivityThreads(threads).some((thread) => thread.id !== activeThreadId);
}
