// FILE: canvasMeasure.ts
// Purpose: Rectangle maths and DOM measurement for the canvas editor: screen and world boxes,
//          the ⌥ distance lines, and how a layer's position is read from its element.
// Layer: Canvas editor geometry
// Exports: rect helpers, camera conversions, elementBox, isFreePositioned, positionedOffset,
//          measureDistances, sizeBadgeText, drawnRect, framesWithBlockedLabels

import type { DesignViewport } from "@synara/contracts";

/** A box in screen pixels (viewport-local) or in world (design) pixels. */
export type MeasureRect = { x: number; y: number; width: number; height: number };
export type ScreenRect = MeasureRect;
export type WorldRect = MeasureRect;
export type Point = { x: number; y: number };

export const intersects = (a: MeasureRect, b: MeasureRect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export const contains = (outer: MeasureRect, inner: MeasureRect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

export const rectFromPoints = (x1: number, y1: number, x2: number, y2: number): MeasureRect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1),
});

/** How a layer sizes along an axis, as the size badge names it (fixed sizes go unnamed). */
export type CanvasSizingName = "fixed" | "fit" | "fill" | "relative";

/**
 * The selection badge's text: W × H, each size led by its sizing mode when that is not fixed
 * ("Fit 320 × Fill 48").
 */
export function sizeBadgeText(
  rect: { width: number; height: number },
  modes?: { width: CanvasSizingName; height: CanvasSizingName } | null,
  names?: Readonly<Record<Exclude<CanvasSizingName, "fixed">, string>>,
): string {
  const side = (value: number, mode: CanvasSizingName | undefined) =>
    mode && mode !== "fixed" && names
      ? `${names[mode]} ${Math.round(value)}`
      : String(Math.round(value));
  return `${side(rect.width, modes?.width)} × ${side(rect.height, modes?.height)}`;
}

/**
 * The frames whose label would cover another frame: the band of `labelHeight` screen pixels
 * above a frame (its label row) overlaps a neighbour sitting close above or beside it.
 */
export function framesWithBlockedLabels(
  frames: readonly (MeasureRect & { id: string })[],
  zoom: number,
  labelHeight: number,
): Set<string> {
  const blocked = new Set<string>();
  const band = labelHeight / zoom;
  for (const frame of frames) {
    const label = { x: frame.x, y: frame.y - band, width: frame.width, height: band };
    if (frames.some((other) => other.id !== frame.id && intersects(label, other)))
      blocked.add(frame.id);
  }
  return blocked;
}

/** A click with a draw tool makes a box this size, centred on the click. */
export const CANVAS_CLICK_DRAW_SIZE = 100;

/**
 * The box a draw tool drags out from `start` to `point`: Shift keeps it square, Alt draws it from
 * the centre outward (both combine).
 */
export function drawnRect(
  start: { x: number; y: number },
  point: { x: number; y: number },
  modifiers: { shift: boolean; alt: boolean },
): MeasureRect {
  let dx = point.x - start.x;
  let dy = point.y - start.y;
  if (modifiers.shift) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = side * (dx < 0 ? -1 : 1);
    dy = side * (dy < 0 ? -1 : 1);
  }
  return modifiers.alt
    ? rectFromPoints(start.x - dx, start.y - dy, start.x + dx, start.y + dy)
    : rectFromPoints(start.x, start.y, start.x + dx, start.y + dy);
}

export const screenToWorldRect = (rect: ScreenRect, camera: DesignViewport): WorldRect => ({
  x: (rect.x - camera.x) / camera.zoom,
  y: (rect.y - camera.y) / camera.zoom,
  width: rect.width / camera.zoom,
  height: rect.height / camera.zoom,
});

export const worldToScreenRect = (rect: WorldRect, camera: DesignViewport): ScreenRect => ({
  x: camera.x + rect.x * camera.zoom,
  y: camera.y + rect.y * camera.zoom,
  width: rect.width * camera.zoom,
  height: rect.height * camera.zoom,
});

/**
 * An element's border box relative to `origin` (a container's client rect), or null when it
 * has no layout box: a hidden layer (`display: none`) would otherwise measure 0×0 at the
 * page's corner.
 */
export function elementBox(element: Element, origin: Pick<DOMRect, "left" | "top">) {
  if (element.getClientRects().length === 0) return null;
  const box = element.getBoundingClientRect();
  return {
    x: box.left - origin.left,
    y: box.top - origin.top,
    width: box.width,
    height: box.height,
  } satisfies ScreenRect;
}

/** Layers placed by `left`/`top` (absolute, or fixed inside the frame) move freely. */
export const isFreePositioned = (element: Element) => {
  const position = getComputedStyle(element).position;
  return position === "absolute" || position === "fixed";
};

/**
 * A layer's layout size in CSS pixels, untouched by transforms and the canvas zoom: its
 * `offsetWidth`/`offsetHeight`, or for an inline SVG (an `SVGElement` has no offset box) the
 * used width and height its computed style resolves to.
 */
export function layoutSize(element: Element): { width: number; height: number } {
  if (element instanceof HTMLElement)
    return { width: element.offsetWidth, height: element.offsetHeight };
  if (element.getClientRects().length === 0) return { width: 0, height: 0 };
  const style = getComputedStyle(element);
  return {
    width: Number.parseFloat(style.width) || 0,
    height: Number.parseFloat(style.height) || 0,
  };
}

/**
 * A layer's offset parent and its position in that parent's padding box (`offsetLeft`,
 * `offsetTop`). An inline SVG has no offset box, so it is measured from its painted box: the
 * centre of the bounding box is the centre of the untransformed box for rotations about the
 * centre (Synara's only transform origin), scaled back by the parent's on-screen size.
 */
export function layoutOffset(element: Element): {
  left: number;
  top: number;
  parent: HTMLElement | null;
} {
  if (element instanceof HTMLElement) {
    const parent = element.offsetParent;
    return {
      left: element.offsetLeft,
      top: element.offsetTop,
      parent: parent instanceof HTMLElement ? parent : null,
    };
  }
  let parent = element.parentElement;
  while (parent && getComputedStyle(parent).position === "static") {
    const next: HTMLElement | null = parent.parentElement;
    if (!next) break;
    parent = next;
  }
  if (!parent || element.getClientRects().length === 0) return { left: 0, top: 0, parent };
  const outer = parent.getBoundingClientRect();
  const scale = parent.offsetWidth > 0 ? outer.width / parent.offsetWidth : 1;
  const box = element.getBoundingClientRect();
  const size = layoutSize(element);
  return {
    left:
      (box.left + box.width / 2 - outer.left) / (scale || 1) - parent.clientLeft - size.width / 2,
    top: (box.top + box.height / 2 - outer.top) / (scale || 1) - parent.clientTop - size.height / 2,
    parent,
  };
}

/**
 * Where a freely placed layer's `left`/`top` put it. `offsetLeft` would add its margin, so a
 * nudge or a drag would jump by the margin; the computed `left` is the used value.
 */
export function positionedOffset(element: Element): Point {
  const style = getComputedStyle(element);
  const left = Number.parseFloat(style.left);
  const top = Number.parseFloat(style.top);
  const offset = Number.isFinite(left) && Number.isFinite(top) ? null : layoutOffset(element);
  return {
    x: Number.isFinite(left) ? left : offset!.left - (Number.parseFloat(style.marginLeft) || 0),
    y: Number.isFinite(top) ? top : offset!.top - (Number.parseFloat(style.marginTop) || 0),
  };
}

/** One axis-aligned distance line in screen space, with its length in design pixels. */
export type MeasureLine = {
  axis: "x" | "y";
  /** Horizontal lines run from x1 to x2 at y; vertical lines from y1 to y2 at x. */
  x: number;
  y: number;
  from: number;
  to: number;
  value: number;
};

const edges = (rect: MeasureRect) => ({
  left: rect.x,
  right: rect.x + rect.width,
  top: rect.y,
  bottom: rect.y + rect.height,
  cx: rect.x + rect.width / 2,
  cy: rect.y + rect.height / 2,
});

const holds = (outer: ReturnType<typeof edges>, inner: ReturnType<typeof edges>) =>
  outer.left <= inner.left &&
  outer.right >= inner.right &&
  outer.top <= inner.top &&
  outer.bottom >= inner.bottom;

/**
 * The ⌥ measurement between the selection and another box: the four insets when one box
 * holds the other, otherwise the horizontal and vertical gaps between them. Lengths are converted
 * to design pixels with the zoom; zero-length lines are dropped.
 */
export function measureDistances(
  selection: MeasureRect,
  target: MeasureRect,
  zoom: number,
): MeasureLine[] {
  const s = edges(selection);
  const t = edges(target);
  const lines: MeasureLine[] = [];
  const push = (axis: "x" | "y", at: number, from: number, to: number) => {
    const length = to - from;
    if (length < 0.5) return;
    lines.push({
      axis,
      x: axis === "y" ? at : 0,
      y: axis === "x" ? at : 0,
      from,
      to,
      value: Math.round(length / zoom),
    });
  };
  const nested = holds(t, s) ? { outer: t, inner: s } : holds(s, t) ? { outer: s, inner: t } : null;
  if (nested) {
    const { outer, inner } = nested;
    push("y", inner.cx, outer.top, inner.top);
    push("y", inner.cx, inner.bottom, outer.bottom);
    push("x", inner.cy, outer.left, inner.left);
    push("x", inner.cy, inner.right, outer.right);
    return lines;
  }
  const overlapTop = Math.max(s.top, t.top);
  const overlapBottom = Math.min(s.bottom, t.bottom);
  const lineY = overlapBottom > overlapTop ? (overlapTop + overlapBottom) / 2 : s.cy;
  if (s.right <= t.left) push("x", lineY, s.right, t.left);
  else if (t.right <= s.left) push("x", lineY, t.right, s.left);
  const overlapLeft = Math.max(s.left, t.left);
  const overlapRight = Math.min(s.right, t.right);
  const lineX = overlapRight > overlapLeft ? (overlapLeft + overlapRight) / 2 : s.cx;
  if (s.bottom <= t.top) push("y", lineX, s.bottom, t.top);
  else if (t.bottom <= s.top) push("y", lineX, t.bottom, s.top);
  return lines;
}
