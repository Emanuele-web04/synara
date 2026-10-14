// FILE: inbox.logic.ts
// Purpose: Pure rules for the Inbox page: the working day, its hours and its morning/
//          afternoon/evening slots, the recap per slot, and the threads that need the user.
// Layer: Web inbox logic
// Exports: resolveInboxDay, recapInputForRange, summarizeInboxSlots, sumRecapBefore,
//          compareWithYesterday, modelIconProvider, collectNeedsYouItems,
//          countNeedsYouActions, groupInboxThreads, selectInboxTasks

import type {
  ProviderKind,
  StatsGetRecapInput,
  StatsGetRecapResult,
  ThreadId,
} from "@synara/contracts";

import type { SidebarThreadSummary } from "../../types";
import { hasUnseenCompletion, resolveThreadStatusPill } from "../Sidebar.logic";
import {
  isActivityThread,
  isThreadRunningForActivity,
  resolveActivityDayStartMs,
} from "../SidebarActivityView.logic";
import { buildTaskSections, toLocalDueDate, type TaskRowModel } from "../tasks/tasks.logic";

export type InboxSlotId = "morning" | "afternoon" | "evening";

const HOUR_MS = 3_600_000;

/** Slot start hours in local time; the working day itself starts with the morning. */
const INBOX_SLOT_START_HOURS: ReadonlyArray<{ id: InboxSlotId; label: string; hour: number }> = [
  { id: "morning", label: "Morning", hour: 4 },
  { id: "afternoon", label: "Afternoon", hour: 12 },
  { id: "evening", label: "Evening", hour: 18 },
];

export interface InboxTimeRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface InboxSlot extends InboxTimeRange {
  readonly id: InboxSlotId;
  readonly label: string;
}

export interface InboxDayRange extends InboxTimeRange {
  readonly slots: readonly InboxSlot[];
  /** Each hour of the day from its start (23 or 25 of them on a daylight-saving night). */
  readonly hours: readonly InboxTimeRange[];
}

export interface InboxDay extends InboxDayRange {
  readonly currentSlotId: InboxSlotId;
  /** The previous working day, for "this time yesterday" comparisons. */
  readonly previousDay: InboxDayRange;
}

function dayRange(dayStartMs: number): InboxDayRange {
  const at = (hour: number, dayOffset = 0) => {
    const date = new Date(dayStartMs);
    date.setDate(date.getDate() + dayOffset);
    date.setHours(hour, 0, 0, 0);
    return date.getTime();
  };
  const [first] = INBOX_SLOT_START_HOURS;
  const endMs = at(first?.hour ?? 4, 1);
  const slots = INBOX_SLOT_START_HOURS.map((slot, index) => {
    const next = INBOX_SLOT_START_HOURS[index + 1];
    return {
      id: slot.id,
      label: slot.label,
      fromMs: at(slot.hour),
      toMs: next ? at(next.hour) : endMs,
    };
  });
  // Real hours, not wall-clock ones: the repeated hour of a fall-back night is its own bar.
  const hours: InboxTimeRange[] = [];
  for (let fromMs = dayStartMs; fromMs < endMs; fromMs += HOUR_MS) {
    hours.push({ fromMs, toMs: Math.min(fromMs + HOUR_MS, endMs) });
  }
  return { fromMs: dayStartMs, toMs: endMs, slots, hours };
}

/**
 * The working day `nowMs` belongs to (4am to 4am, like the Activity view's Recent
 * section) split into morning, afternoon, and evening. Boundaries come from local
 * wall-clock hours, so a daylight-saving change only shortens or stretches a slot.
 */
export function resolveInboxDay(nowMs: number): InboxDay {
  const today = dayRange(resolveActivityDayStartMs(nowMs));
  const previousDayStart = new Date(today.fromMs);
  previousDayStart.setDate(previousDayStart.getDate() - 1);
  const currentSlot =
    today.slots.find((slot) => nowMs >= slot.fromMs && nowMs < slot.toMs) ?? today.slots.at(-1);
  return {
    ...today,
    currentSlotId: currentSlot?.id ?? "morning",
    previousDay: dayRange(previousDayStart.getTime()),
  };
}

/** The `stats.getRecap` request for a day, bucketed by hour. */
export function recapInputForRange(range: InboxDayRange): StatsGetRecapInput {
  return {
    from: new Date(range.fromMs).toISOString(),
    to: new Date(range.toMs).toISOString(),
    slotBoundaries: range.hours.slice(1).map((hour) => new Date(hour.fromMs).toISOString()),
  };
}

type RecapBucket = StatsGetRecapResult["slots"][number];

export function recapTokens(bucket: Pick<RecapBucket, "tokens">): number {
  return bucket.tokens.user + bucket.tokens.automation + bucket.tokens.agent;
}

/** The recap's hourly buckets by start time, so an hour finds its own bucket. */
export function recapBucketsByStart(recap: StatsGetRecapResult): ReadonlyMap<number, RecapBucket> {
  return new Map(recap.slots.map((bucket) => [Date.parse(bucket.from), bucket]));
}

export interface InboxSlotSummary {
  readonly id: InboxSlotId;
  readonly label: string;
  readonly status: "done" | "now";
  readonly prompts: number;
  readonly turns: number;
  readonly tokens: number;
  readonly agentWorkMs: number;
  /** Tokens per hour inside the slot, in order; hours that have not started are `future`. */
  readonly hours: readonly {
    readonly fromMs: number;
    readonly tokens: number;
    readonly future: boolean;
  }[];
}

/**
 * The slots worth showing: the one in progress, plus earlier ones that had any activity.
 * Slots that have not started yet never show; an idle past slot says nothing.
 */
export function summarizeInboxSlots(
  recap: StatsGetRecapResult,
  day: InboxDayRange,
  nowMs: number,
): InboxSlotSummary[] {
  const bucketByStart = recapBucketsByStart(recap);
  const summaries: InboxSlotSummary[] = [];
  for (const slot of day.slots) {
    if (slot.fromMs > nowMs) continue;
    const slotHours = day.hours.flatMap((hour) => {
      const bucket = bucketByStart.get(hour.fromMs);
      return bucket && hour.fromMs >= slot.fromMs && hour.fromMs < slot.toMs
        ? [{ bucket, fromMs: hour.fromMs, future: hour.fromMs > nowMs }]
        : [];
    });
    const buckets = slotHours.map((hour) => hour.bucket);
    const summary: InboxSlotSummary = {
      id: slot.id,
      label: slot.label,
      status: nowMs < slot.toMs ? "now" : "done",
      prompts: buckets.reduce((sum, bucket) => sum + bucket.prompts, 0),
      turns: buckets.reduce((sum, bucket) => sum + bucket.turns, 0),
      tokens: buckets.reduce((sum, bucket) => sum + recapTokens(bucket), 0),
      agentWorkMs: buckets.reduce((sum, bucket) => sum + bucket.agentWorkMs, 0),
      hours: slotHours.map((hour) => ({
        fromMs: hour.fromMs,
        tokens: recapTokens(hour.bucket),
        future: hour.future,
      })),
    };
    // Agent time counts: a turn that started earlier can keep a slot busy on its own.
    const idle =
      summary.prompts === 0 &&
      summary.turns === 0 &&
      summary.tokens === 0 &&
      summary.agentWorkMs === 0;
    if (summary.status === "now" || !idle) summaries.push(summary);
  }
  return summaries;
}

export interface RecapTotals {
  readonly prompts: number;
  readonly turns: number;
  readonly tokens: number;
  readonly agentWorkMs: number;
}

/** The comparison cutoff for the same local clock time on the previous day. */
export function previousDayCutoffMs(asOfMs: number): number {
  const previous = new Date(asOfMs);
  previous.setDate(previous.getDate() - 1);
  return previous.getTime();
}

/**
 * A day's additive totals up to `cutoffMs` (the hour holding the cutoff counts
 * pro rata), so the morning is compared with yesterday's morning, not all of yesterday.
 */
export function sumRecapBefore(
  recap: StatsGetRecapResult,
  day: InboxDayRange,
  cutoffMs: number,
): RecapTotals {
  const bucketByStart = recapBucketsByStart(recap);
  const totals = { prompts: 0, turns: 0, tokens: 0, agentWorkMs: 0 };
  day.hours.forEach((hour) => {
    const bucket = bucketByStart.get(hour.fromMs);
    if (!bucket || hour.fromMs >= cutoffMs) return;
    const share = Math.min(1, (cutoffMs - hour.fromMs) / (hour.toMs - hour.fromMs));
    totals.prompts += bucket.prompts * share;
    totals.turns += bucket.turns * share;
    totals.tokens += recapTokens(bucket) * share;
    totals.agentWorkMs += bucket.agentWorkMs * share;
  });
  return totals;
}

/** "+17%" style change against yesterday; nothing when yesterday had none to compare. */
export function compareWithYesterday(
  today: number,
  yesterday: number | null | undefined,
): { readonly label: string; readonly trend: "up" | "down" | "flat" } | null {
  if (yesterday === null || yesterday === undefined || yesterday < 1) return null;
  const change = Math.round(((today - yesterday) / yesterday) * 100);
  if (change === 0) return { label: "same as yesterday", trend: "flat" };
  return { label: `${change > 0 ? "+" : ""}${change}%`, trend: change > 0 ? "up" : "down" };
}

/**
 * Which brand icon a model gets: the model's maker when its name says so (a Claude model
 * served through Cursor still shows Claude), otherwise the provider that ran it. A vendor
 * prefix ("openai/gpt-5") does not hide the maker.
 */
export function modelIconProvider(
  provider: ProviderKind | "unknown",
  model: string,
): ProviderKind | null {
  const name = model.toLowerCase();
  if (/(^|[/:])(gpt|o\d|codex|chatgpt)/.test(name)) return "codex";
  if (/claude|opus|sonnet|haiku/.test(name)) return "claudeAgent";
  if (/grok/.test(name)) return "grok";
  if (/composer|cursor/.test(name)) return "cursor";
  return provider === "unknown" ? null : provider;
}

export type NeedsYouKind = "approval" | "input" | "plan" | "failed" | "unread";

export interface NeedsYouItem {
  readonly kind: NeedsYouKind;
  readonly thread: SidebarThreadSummary;
}

/** The kinds that wait on an action from the user; the badge and "Needs you" count these. */
const NEEDS_YOU_ACTION_KINDS: ReadonlySet<NeedsYouKind> = new Set(["approval", "input", "plan"]);

const NEEDS_YOU_ORDER: Record<NeedsYouKind, number> = {
  approval: 0,
  input: 1,
  plan: 2,
  failed: 3,
  unread: 4,
};

/** A finished turn that failed and the user has not opened since. */
export function isUnseenFailedThread(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "lastVisitedAt">,
): boolean {
  return thread.latestTurn?.state === "error" && hasUnseenCompletion(thread);
}

/** Status pills the user dismissed in the sidebar, by thread; a dismissed pill never counts. */
export type DismissedThreadStatusKeys = Readonly<Record<string, string>>;

const NO_DISMISSALS: DismissedThreadStatusKeys = {};

function needsYouKind(
  thread: SidebarThreadSummary,
  dismissed: DismissedThreadStatusKeys,
): NeedsYouKind | null {
  const status = resolveThreadStatusPill({
    thread: { ...thread, dismissedStatusKey: dismissed[thread.id] },
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
  });
  if (status?.label === "Pending Approval") return "approval";
  if (status?.label === "Awaiting Input") return "input";
  if (status?.label === "Plan Ready") return "plan";
  if (status?.label === "Reminder") return "unread";
  // The sidebar shows a failed turn as a plain completion, so dismissing it hides both.
  if (status?.label === "Completed") return isUnseenFailedThread(thread) ? "failed" : "unread";
  return null;
}

/**
 * Threads that are waiting on the user, most urgent first: the same status rules the
 * sidebar rows use, plus failed turns (which the sidebar shows as a plain completion).
 * Within a kind, the most recently updated thread comes first.
 */
export function collectNeedsYouItems(
  threads: readonly SidebarThreadSummary[],
  dismissed: DismissedThreadStatusKeys = NO_DISMISSALS,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const thread of threads) {
    if (thread.snoozedUntil != null || !isActivityThread(thread)) continue;
    const kind = needsYouKind(thread, dismissed);
    if (kind) items.push({ kind, thread });
  }
  return items.toSorted(
    (left, right) =>
      NEEDS_YOU_ORDER[left.kind] - NEEDS_YOU_ORDER[right.kind] ||
      (Date.parse(right.thread.updatedAt ?? "") || 0) -
        (Date.parse(left.thread.updatedAt ?? "") || 0) ||
      left.thread.id.localeCompare(right.thread.id),
  );
}

/**
 * What the rail badge counts: the threads in the Inbox's "Needs you" group, minus the
 * one the user has open. Counts without sorting, since it runs on every sidebar change.
 */
export function countNeedsYouActions(
  threads: readonly SidebarThreadSummary[],
  activeThreadId: ThreadId | null,
  dismissed: DismissedThreadStatusKeys = NO_DISMISSALS,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.snoozedUntil != null || thread.id === activeThreadId || !isActivityThread(thread))
      continue;
    const kind = needsYouKind(thread, dismissed);
    if (kind && NEEDS_YOU_ACTION_KINDS.has(kind)) count += 1;
  }
  return count;
}

export interface InboxThreadGroups {
  /** Approvals, questions, and plans, most urgent first. */
  readonly needsYou: readonly NeedsYouItem[];
  readonly working: readonly SidebarThreadSummary[];
  /** Completions the user has not opened yet. */
  readonly finished: readonly SidebarThreadSummary[];
  readonly failed: readonly SidebarThreadSummary[];
}

const byLatestUpdate = (left: SidebarThreadSummary, right: SidebarThreadSummary) =>
  (Date.parse(right.updatedAt ?? "") || 0) - (Date.parse(left.updatedAt ?? "") || 0) ||
  left.id.localeCompare(right.id);

/** Splits the activity threads into the Inbox lists; a thread lands in at most one. */
export function groupInboxThreads(
  threads: readonly SidebarThreadSummary[],
  dismissed: DismissedThreadStatusKeys = NO_DISMISSALS,
): InboxThreadGroups {
  const items = collectNeedsYouItems(threads, dismissed);
  const listed = new Set(items.map((item) => item.thread.id));
  return {
    needsYou: items.filter((item) => NEEDS_YOU_ACTION_KINDS.has(item.kind)),
    working: threads
      .filter(
        (thread) =>
          thread.snoozedUntil == null &&
          isActivityThread(thread) &&
          !listed.has(thread.id) &&
          isThreadRunningForActivity(thread),
      )
      .toSorted(byLatestUpdate),
    finished: items.filter((item) => item.kind === "unread").map((item) => item.thread),
    failed: items.filter((item) => item.kind === "failed").map((item) => item.thread),
  };
}

export interface InboxTasks {
  /** Open to-dos that count today, in the Tasks list's order. */
  readonly open: readonly TaskRowModel[];
  /** To-dos finished during this working day, newest first. */
  readonly doneToday: readonly TaskRowModel[];
  /** How many of the open ones were due before today. */
  readonly overdue: number;
}

/**
 * The to-dos that belong to today: open ones due today or earlier, ones an agent is working
 * on or waiting with, and ones finished since the working day started. The backlog (no due
 * day, or a later one) stays on the Tasks page. "Due today" follows the calendar date, as
 * the rows' own due labels do.
 */
export function selectInboxTasks(
  rows: readonly TaskRowModel[],
  day: InboxTimeRange,
  nowMs: number,
): InboxTasks {
  const today = toLocalDueDate(new Date(nowMs));
  const { sections, completed } = buildTaskSections(
    rows.filter(({ todo, status }) => {
      if (status.kind === "done") {
        const completedAtMs = Date.parse(todo.completedAt ?? "");
        return completedAtMs >= day.fromMs && completedAtMs < day.toMs;
      }
      return status.kind !== "todo" || (todo.dueDate !== null && todo.dueDate <= today);
    }),
  );
  const open = sections.flatMap((section) => section.rows);
  return {
    open,
    doneToday: completed,
    overdue: open.filter(({ todo }) => todo.dueDate !== null && todo.dueDate < today).length,
  };
}
