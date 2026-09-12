import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import type { MindHistoryEntry, MindMemory } from "@synara/contracts";

/** True while the loaded page is truncated: fewer rows shown than the true total. */
export function isMindListTruncated(input: {
  readonly shown: number;
  readonly total: number;
}): boolean {
  return input.shown < input.total;
}

/** "N memories · P pinned · cap C", or "Showing S of N memories · …" when truncated. */
export function formatMindCountLabel(input: {
  readonly shown: number;
  readonly total: number;
  readonly pinnedCount: number;
  readonly cap: number;
}): string {
  const noun = pluralize(input.total, "memory", "memories");
  const head = isMindListTruncated(input)
    ? `Showing ${input.shown} of ${input.total} ${noun}`
    : `${input.total} ${noun}`;
  return `${head} · ${input.pinnedCount} pinned · cap ${input.cap}`;
}

/**
 * Optimistic count after a forget: decrement only when the whole store is
 * loaded. While truncated the count is the true total and the
 * invalidate-on-settle refetch converges it — decrementing eagerly would
 * flicker the "Showing S of N" denominator before the server confirms.
 */
export function optimisticForgetCount(input: {
  readonly count: number;
  readonly shown: number;
}): number {
  if (isMindListTruncated({ shown: input.shown, total: input.count })) return input.count;
  return Math.max(0, input.count - 1);
}

/**
 * Weight-desc with memory-id tie-break — the same order the server sends, so
 * optimistic edits and cache merges never reorder rows out from under the UI.
 */
export function sortMindMemories(memories: ReadonlyArray<MindMemory>): MindMemory[] {
  return [...memories].toSorted(
    (a, b) => b.weight - a.weight || a.memoryId.localeCompare(b.memoryId),
  );
}

export interface MindDayGroup {
  readonly key: string;
  readonly label: string;
  readonly memories: ReadonlyArray<MindMemory>;
}

const DAY_MS = 86_400_000;

const startOfLocalDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const padDayPart = (value: number): string => String(value).padStart(2, "0");

/** Local-day label for a group header: Today / Yesterday / "Sep 12, 2026". */
export function formatMindDayLabel(dayStart: Date, now: Date = new Date()): string {
  const todayStart = startOfLocalDay(now).getTime();
  const diffDays = Math.round((startOfLocalDay(dayStart).getTime() - todayStart) / DAY_MS);
  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  return dayStart.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Buckets memories by createdAt local day, newest day first. Memories inside
 * each day stay weight-desc (same sort as the server page).
 */
export function groupMindMemoriesByDay(
  memories: ReadonlyArray<MindMemory>,
  now: Date = new Date(),
): MindDayGroup[] {
  const sorted = sortMindMemories(memories);
  const byKey = new Map<string, { readonly dayStart: Date | null; readonly items: MindMemory[] }>();
  for (const memory of sorted) {
    const parsed = new Date(memory.createdAt);
    if (Number.isNaN(parsed.getTime())) {
      const entry = byKey.get("unknown") ?? { dayStart: null, items: [] };
      entry.items.push(memory);
      byKey.set("unknown", entry);
      continue;
    }
    const dayStart = startOfLocalDay(parsed);
    const key = `${dayStart.getFullYear()}-${padDayPart(dayStart.getMonth() + 1)}-${padDayPart(dayStart.getDate())}`;
    const entry = byKey.get(key) ?? { dayStart, items: [] };
    entry.items.push(memory);
    byKey.set(key, entry);
  }
  return [...byKey]
    .toSorted((a, b) => {
      const aTime = a[1].dayStart?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bTime = b[1].dayStart?.getTime() ?? Number.NEGATIVE_INFINITY;
      return bTime - aTime;
    })
    .map(([key, entry]) => ({
      key,
      label: entry.dayStart === null ? "Unknown date" : formatMindDayLabel(entry.dayStart, now),
      memories: entry.items,
    }));
}

/** Idle days after which an unpinned memory counts as stale in the digest line. */
export const MIND_STALE_IDLE_DAYS = 30;

/** Unpinned memories idle (not recalled/affirmed) for more than 30 days. */
export function countStaleMindMemories(
  memories: ReadonlyArray<MindMemory>,
  nowMs: number = Date.now(),
): number {
  return memories.filter(
    (memory) =>
      !memory.pinned && nowMs - Date.parse(memory.lastAccessedAt) > MIND_STALE_IDLE_DAYS * DAY_MS,
  ).length;
}

/** Share of the project cap in use, 0–100+ (over cap stays honest, never clamped). */
export function mindCapPercent(input: { readonly count: number; readonly cap: number }): number {
  if (input.cap <= 0) return 0;
  return Math.round((input.count / input.cap) * 100);
}

/**
 * Digest signals appended to the meta count line: stale count plus cap
 * pressure, e.g. " · 3 stale · 80% of cap". Empty only when there is nothing
 * to say (no cap and nothing stale).
 */
export function formatMindDigestSuffix(input: {
  readonly staleCount: number;
  readonly count: number;
  readonly cap: number;
}): string {
  const parts: string[] = [];
  if (input.staleCount > 0) {
    parts.push(`${input.staleCount} stale`);
  }
  if (input.cap > 0) {
    parts.push(`${mindCapPercent({ count: input.count, cap: input.cap })}% of cap`);
  }
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

/**
 * Optimistic weight after a Still-true affirm: the confirm bump (+0.15, capped
 * at 1.0) applied to the displayed effective weight, rounded like the server.
 * The invalidate-on-settle refetch converges to the true effective weight.
 */
export function optimisticAffirmWeight(weight: number): number {
  return Math.min(1, Number((weight + 0.15).toFixed(4)));
}

/**
 * Honest history framing: the timeline carries who/when only — revision and
 * journal rows never store memory text, so there are no diffs to show.
 */
export const MIND_HISTORY_NOTE = "History shows when each change happened, not what changed.";

/** Past-tense verb for each timeline op (`edit` comes from the revision table). */
export function formatMindHistoryOpLabel(op: MindHistoryEntry["op"]): string {
  switch (op) {
    case "remember":
      return "Saved";
    case "confirm":
      return "Confirmed";
    case "edit":
      return "Edited";
    case "pin":
      return "Pinned";
    case "unpin":
      return "Unpinned";
    case "forget":
      return "Forgotten";
    case "prune":
      return "Pruned";
  }
}

/** Who acted: the viewer for user rows, the provider for agent rows. */
export function formatMindHistoryActorLabel(actor: MindHistoryEntry["actor"]): string {
  if (actor.kind === "user") return "you";
  return `agent · ${PROVIDER_DISPLAY_NAMES[actor.provider]}`;
}
