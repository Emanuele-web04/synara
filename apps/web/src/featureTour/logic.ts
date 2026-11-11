// FILE: logic.ts
// Purpose: Pure rules for the app tour: which steps to show for the controls on screen,
//          and where the step card goes beside the control it points at.
// Layer: Web UI logic (no React, no DOM)
// Exports: resolveTourSteps, placeTourCard, TourRect, TourCardPlacement

export interface TourRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TourCardPlacement {
  readonly left: number;
  readonly top: number;
  /** Which side of the anchor the card sits on; `center` when there is no anchor. */
  readonly side: "right" | "bottom" | "left" | "top" | "center";
  /** Where the caret points along the card's facing edge, in card pixels. */
  readonly caret: number | null;
}

/**
 * Steps whose control is hidden (a rail item the user removed, a narrow window) are
 * skipped. When none of the controls are on screen the tour still runs, every card
 * centered, so it never silently vanishes.
 */
export function resolveTourSteps<Step extends { readonly anchor: string }>(
  steps: readonly Step[],
  isOnScreen: (anchor: string) => boolean,
): ReadonlyArray<{ readonly step: Step; readonly anchored: boolean }> {
  const anchored = steps.filter((step) => isOnScreen(step.anchor));
  return anchored.length > 0
    ? anchored.map((step) => ({ step, anchored: true }))
    : steps.map((step) => ({ step, anchored: false }));
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** Keeps the caret clear of the card's rounded corners. */
const CARET_INSET = 22;

/**
 * Prefers the right of the anchor (the rail and sidebar sit on the left), then below,
 * left, above. The card's top aligns a little above the anchor so it hangs down beside
 * it, and always stays `margin` inside the viewport.
 */
export function placeTourCard(input: {
  readonly anchor: TourRect | null;
  readonly card: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gap?: number;
  readonly margin?: number;
}): TourCardPlacement {
  const { anchor, card, viewport } = input;
  const gap = input.gap ?? 14;
  const margin = input.margin ?? 12;
  const maxLeft = viewport.width - margin - card.width;
  const maxTop = viewport.height - margin - card.height;
  const center: TourCardPlacement = {
    left: clamp((viewport.width - card.width) / 2, margin, maxLeft),
    top: clamp((viewport.height - card.height) / 2, margin, maxTop),
    side: "center",
    caret: null,
  };
  if (!anchor) return center;

  const anchorCenterX = anchor.left + anchor.width / 2;
  const anchorCenterY = anchor.top + anchor.height / 2;
  const besideTop = clamp(anchor.top - 20, margin, maxTop);
  const stackedLeft = clamp(anchorCenterX - card.width / 2, margin, maxLeft);
  const verticalCaret = (top: number) =>
    clamp(anchorCenterY - top, CARET_INSET, card.height - CARET_INSET);
  const horizontalCaret = (left: number) =>
    clamp(anchorCenterX - left, CARET_INSET, card.width - CARET_INSET);

  const right = anchor.left + anchor.width + gap;
  if (right + card.width <= viewport.width - margin) {
    return { left: right, top: besideTop, side: "right", caret: verticalCaret(besideTop) };
  }
  const below = anchor.top + anchor.height + gap;
  if (below + card.height <= viewport.height - margin) {
    return { left: stackedLeft, top: below, side: "bottom", caret: horizontalCaret(stackedLeft) };
  }
  const left = anchor.left - gap - card.width;
  if (left >= margin) {
    return { left, top: besideTop, side: "left", caret: verticalCaret(besideTop) };
  }
  const above = anchor.top - gap - card.height;
  if (above >= margin) {
    return { left: stackedLeft, top: above, side: "top", caret: horizontalCaret(stackedLeft) };
  }
  return center;
}
