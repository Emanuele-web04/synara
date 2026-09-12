import { pluralize } from "@synara/shared/text";

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
