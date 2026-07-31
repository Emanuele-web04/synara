export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;

interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function getScrollContainerDistanceFromBottom(position: ScrollPosition): number {
  const { scrollTop, clientHeight, scrollHeight } = position;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return 0;
  }

  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function isScrollContainerNearBottom(
  position: ScrollPosition,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX;

  return getScrollContainerDistanceFromBottom(position) <= threshold;
}

export interface TailAnchorSpacerInput {
  /** Scroll container clientHeight. */
  viewportHeightPx: number;
  /** Distance from the anchored user message's top edge to the spacer's top edge. */
  anchorTopToSpacerTopPx: number;
  /** Fixed space that always trails the spacer (scroll container bottom padding). */
  trailingInsetPx: number;
  /**
   * Gap kept between the viewport top and the anchored message (scroll container
   * top padding), so an anchored message breathes like the first message of a chat.
   */
  topInsetPx: number;
  /** Minimum spacer height (the transcript's base bottom content inset). */
  baseInsetPx: number;
}

/**
 * Height for the transcript's tail spacer while a just-sent user message is
 * anchored: sized so that scrolling to the end of the list puts the anchored
 * message's top edge `topInsetPx` below the top of the viewport. As the
 * streaming response grows, the returned height shrinks by the same amount,
 * keeping the total scroll height constant (the message stays pinned) until the
 * response overflows the viewport and normal follow-the-tail scrolling resumes.
 */
export function computeTailAnchorSpacerHeightPx(input: TailAnchorSpacerInput): number {
  const { viewportHeightPx, anchorTopToSpacerTopPx, trailingInsetPx, topInsetPx, baseInsetPx } =
    input;
  const base = Number.isFinite(baseInsetPx) && baseInsetPx > 0 ? Math.round(baseInsetPx) : 0;
  if (
    ![viewportHeightPx, anchorTopToSpacerTopPx, trailingInsetPx, topInsetPx].every(
      Number.isFinite,
    ) ||
    viewportHeightPx <= 0
  ) {
    return base;
  }

  const desired =
    viewportHeightPx -
    Math.max(0, topInsetPx) -
    anchorTopToSpacerTopPx -
    Math.max(0, trailingInsetPx);
  // Never reserve more than one viewport of space, and never less than the base inset.
  return Math.max(base, Math.round(Math.min(desired, viewportHeightPx)));
}
