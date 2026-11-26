// FILE: canvasPinPlacement.ts
// Purpose: Keeps comment pins off the selection's size badge. The badge keeps its place under
//          the selection; a pin that would cover it steps aside, the shortest way out. The rule
//          is pure (pinShiftClearOfBadge); scheduleCommentPinClearance applies it to the DOM once
//          per frame, without a render, when the badge, the pins or the zoom change.
// Layer: Canvas editor UI
// Exports: pinShiftClearOfBadge, scheduleCommentPinClearance, PIN_BADGE_GAP,
//          CANVAS_SIZE_BADGE_ATTRIBUTE, CANVAS_PIN_ANCHOR_ATTRIBUTE

/** A box on screen, in pixels. */
export type ScreenBox = { left: number; top: number; right: number; bottom: number };

/** Room kept between a pin that stepped aside and the badge. */
export const PIN_BADGE_GAP = 4;

/** Marks the W × H badge (one selection, or the bounds of several). */
export const CANVAS_SIZE_BADGE_ATTRIBUTE = "data-canvas-size-badge";
/** Marks the element that places a comment pin at its anchor; the shift is applied to it. */
export const CANVAS_PIN_ANCHOR_ATTRIBUTE = "data-canvas-pin-anchor";

/**
 * How far a pin moves so it no longer covers the badge, in screen pixels. A pin within `gap` of
 * the badge moves left, right or down past it, whichever is shortest; a tie goes to the first of
 * those three. It never moves up, where the selection it measures is. A clear pin stays put.
 */
export function pinShiftClearOfBadge(
  pin: ScreenBox,
  badge: ScreenBox,
  gap = PIN_BADGE_GAP,
): { x: number; y: number } {
  const clear =
    pin.right <= badge.left - gap ||
    pin.left >= badge.right + gap ||
    pin.bottom <= badge.top - gap ||
    pin.top >= badge.bottom + gap;
  if (clear) return { x: 0, y: 0 };
  const candidates = [
    { x: badge.left - gap - pin.right, y: 0 },
    { x: badge.right + gap - pin.left, y: 0 },
    { x: 0, y: badge.bottom + gap - pin.top },
  ];
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1))
    if (Math.abs(candidate.x) + Math.abs(candidate.y) < Math.abs(best.x) + Math.abs(best.y))
      best = candidate;
  return best;
}

const boxOf = (rect: DOMRect, shift: { x: number; y: number } = { x: 0, y: 0 }): ScreenBox => ({
  left: rect.left - shift.x,
  top: rect.top - shift.y,
  right: rect.right - shift.x,
  bottom: rect.bottom - shift.y,
});

const appliedShift = new WeakMap<HTMLElement, { x: number; y: number }>();

/** Moves every pin in `viewport` clear of the size badge (or back, once it is clear). */
function clearCommentPins(viewport: HTMLElement) {
  const badges = [...viewport.querySelectorAll<HTMLElement>(`[${CANVAS_SIZE_BADGE_ATTRIBUTE}]`)]
    .map((element) => element.getBoundingClientRect())
    // A badge hidden during a gesture has no box.
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => boxOf(rect));
  for (const anchor of viewport.querySelectorAll<HTMLElement>(`[${CANVAS_PIN_ANCHOR_ATTRIBUTE}]`)) {
    const pin = anchor.querySelector<HTMLElement>("[data-canvas-comment-pin]") ?? anchor;
    const current = appliedShift.get(anchor) ?? { x: 0, y: 0 };
    // Measured where it would be without the shift it has now.
    const natural = boxOf(pin.getBoundingClientRect(), current);
    let shift = { x: 0, y: 0 };
    for (const badge of badges) {
      const next = pinShiftClearOfBadge(
        {
          left: natural.left + shift.x,
          right: natural.right + shift.x,
          top: natural.top + shift.y,
          bottom: natural.bottom + shift.y,
        },
        badge,
      );
      shift = { x: shift.x + next.x, y: shift.y + next.y };
    }
    if (shift.x === current.x && shift.y === current.y) continue;
    appliedShift.set(anchor, shift);
    anchor.style.translate = shift.x || shift.y ? `${shift.x}px ${shift.y}px` : "";
  }
}

const scheduled = new WeakMap<HTMLElement, number>();

/**
 * Clears the pins of `viewport` on the next frame, once whatever changed has been laid out.
 * Several requests in one frame run once.
 */
export function scheduleCommentPinClearance(viewport: HTMLElement | null) {
  if (!viewport || scheduled.has(viewport)) return;
  scheduled.set(
    viewport,
    requestAnimationFrame(() => {
      scheduled.delete(viewport);
      if (viewport.isConnected) clearCommentPins(viewport);
    }),
  );
}
