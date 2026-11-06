// FILE: transcriptFollow.ts
// Purpose: The follow-tail rules of a bot thread's transcript (HoloBot's thread/Transcript.tsx),
//          kept pure so they are tested without a browser. While the reader is at the end the
//          list stays there as rows come and grow (a reply, the typing row, a card, the composer
//          growing); an upward scroll leaves the tail and nothing but the reader (scrolling back
//          to the end) or an explicit jump (Send, the round "latest" button) follows again. Rows
//          growing, work, reconnects and pending approvals never re-arm a detached reader.
// Layer: SynBot thread view logic (pure)
// Exports: TAIL_SLACK, FAR, ScrollMetrics, FollowState, initialFollow, afterScroll,
//          shouldPin, showsLatest

/** Within this many pixels of the end counts as at the end. */
export const TAIL_SLACK = 48;
/** The jump to the latest shows once the list is this far above its end, and hides again
 * only near the end, so it never blinks while a reply comes in. */
export const FAR = 240;

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface FollowState {
  /** The end stays in view as the content grows. */
  readonly following: boolean;
  /** The scroll position at the last scroll event (an upward move leaves the tail). */
  readonly lastTop: number;
}

export const initialFollow: FollowState = { following: true, lastTop: 0 };

const below = (metrics: ScrollMetrics) =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;

/** A scroll event: an upward move off the end leaves the tail; reaching the end follows again. */
export function afterScroll(state: FollowState, metrics: ScrollMetrics): FollowState {
  const rest = below(metrics);
  if (metrics.scrollTop < state.lastTop && rest > 1) {
    return { following: false, lastTop: metrics.scrollTop };
  }
  if (rest < TAIL_SLACK) return { following: true, lastTop: metrics.scrollTop };
  return { following: state.following, lastTop: metrics.scrollTop };
}

/** Content changed size: pin to the end only while following and the reader did not just
 * scroll up (a scroll event not handled yet). */
export function shouldPin(state: FollowState, metrics: ScrollMetrics): boolean {
  if (!state.following) return false;
  return !(metrics.scrollTop < state.lastTop && below(metrics) > 1);
}

/** Whether the round "latest" button shows: past FAR while detached; once shown, until the
 * reader is back near the end. */
export function showsLatest(
  state: FollowState,
  metrics: ScrollMetrics,
  shownBefore: boolean,
): boolean {
  return !state.following && below(metrics) > (shownBefore ? TAIL_SLACK : FAR);
}
