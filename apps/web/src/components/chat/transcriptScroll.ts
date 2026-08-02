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
 * Time constant of the anchored-send slide's exponential approach. Each frame
 * closes ~`1 - e^(-dt/τ)` of the remaining distance, so the motion is smooth,
 * never overshoots, and — unlike a fixed-target native smooth scroll — absorbs a
 * target that moves mid-flight (rows above the anchor settling to their real
 * height, the list's end-space reserve growing) instead of landing wrong and
 * needing a visible correction. ~90ms covers ~99% of the distance in 400ms.
 */
export const ANCHOR_SLIDE_TIME_CONSTANT_MS = 90;
/** Below this the approach is finished by snapping, so the anchor lands exactly. */
export const ANCHOR_SLIDE_SNAP_DISTANCE_PX = 0.5;

/**
 * Next scroll offset for one frame of the anchored slide. `target` is read fresh
 * every frame by the caller, which is what makes the motion robust to layout
 * that changes while the slide is in flight.
 */
export function advanceAnchorSlideOffset(input: {
  readonly current: number;
  readonly target: number;
  readonly deltaMs: number;
  readonly timeConstantMs?: number;
}): number {
  const distance = input.target - input.current;
  if (Math.abs(distance) <= ANCHOR_SLIDE_SNAP_DISTANCE_PX) {
    return input.target;
  }
  const timeConstantMs = input.timeConstantMs ?? ANCHOR_SLIDE_TIME_CONSTANT_MS;
  if (!(input.deltaMs > 0) || !(timeConstantMs > 0)) {
    return input.target;
  }
  const progress = 1 - Math.exp(-input.deltaMs / timeConstantMs);
  const next = input.current + distance * progress;
  // Guarantee convergence (and termination) when a long frame or a tiny
  // remaining distance would otherwise leave sub-pixel residue forever.
  return Math.abs(input.target - next) <= ANCHOR_SLIDE_SNAP_DISTANCE_PX ? input.target : next;
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
