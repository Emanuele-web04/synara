import type { LegendListRef } from "@legendapp/list/react";

export type TranscriptScrollTarget = Pick<LegendListRef, "scrollToEnd">;

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
