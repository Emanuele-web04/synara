import type { LegendListRef } from "@legendapp/list/react";

export type TranscriptScrollTarget = Pick<LegendListRef, "scrollToEnd">;
export type TranscriptScrollCancellationTarget = Pick<
  LegendListRef,
  "getScrollableNode" | "scrollToOffset"
>;

/** Stop an in-flight native smooth scroll without changing the visible offset. */
export function stopTranscriptScrollAtCurrentOffset(
  target: TranscriptScrollCancellationTarget,
): Promise<void> {
  const scrollNode = target.getScrollableNode();
  const offset = scrollNode.scrollTop;
  // Cancel the browser's native smooth animation immediately. The LegendList
  // call below then clears its imperative-scroll bookkeeping at the same spot.
  scrollNode.scrollTo({ top: offset, behavior: "auto" });
  return target.scrollToOffset({
    offset,
    animated: false,
  });
}

/**
 * A smooth virtual-list jump can finish using estimated row sizes, before the
 * newly mounted tail rows have reported their real height. Re-issuing the jump
 * without animation after that first request settles uses those measurements
 * and lands on the actual end. The current-target guard prevents a completed
 * request from moving a replacement list after a thread switch or user scroll.
 */
export async function scrollTranscriptToSettledEnd(input: {
  readonly target: TranscriptScrollTarget;
  readonly isCurrent: () => boolean;
  readonly beforeFinalScroll?: () => void;
}): Promise<boolean> {
  await input.target.scrollToEnd({ animated: true });
  if (!input.isCurrent()) {
    return false;
  }

  input.beforeFinalScroll?.();
  await input.target.scrollToEnd({ animated: false });
  return input.isCurrent();
}
