// FILE: canvasGestures.ts
// Purpose: The geometry of canvas gestures, apart from React: resize handles, drag positions,
//          and where a dragged flow layer would drop inside its layout.
// Layer: Canvas editor gestures
// Exports: DRAG_THRESHOLD, ResizeHandle, resizeGeometry, dragPosition, constrainToAxis,
//          rotateDelta, resolveFlowDrop, resolveParentDrop, offsetInParent, SpacingHandle,
//          spacingValue

import type { DesignFrame } from "@synara/contracts";
import { DESIGN_LAYER_ATTRIBUTE, DESIGN_VOID_TAGS } from "@synara/shared/designCanvasLayers";
import type { CanvasEditorApi } from "./CanvasEditorContext";
import type { FlowDrop } from "./canvasGestureLayer";
import { isFreePositioned, type Point, type ScreenRect, type WorldRect } from "./canvasMeasure";
import {
  elementChildren,
  isTextOnly,
  layerLabel,
  layerSiblings,
  type LayerIndex,
  type LayerItem,
} from "./canvasSelection";

/** Screen pixels a press travels before it becomes a drag. */
export const DRAG_THRESHOLD = 5;

/**
 * Set on the viewport while a gesture really drags (a move, resize, spacing drag, draw, marquee
 * or pan past the drag threshold): the floating toolbar fades out of the way until it ends.
 */
export const CANVAS_DRAGGING_ATTRIBUTE = "data-canvas-dragging";

/**
 * Whether a gesture in progress hides the floating chrome. A press does once it has turned into
 * a drag; a comment press never does; every other gesture (resize, spacing, draw, marquee, pan)
 * once the pointer is `distance` screen pixels past the drag threshold, so a plain click on the
 * canvas never flickers the toolbar.
 */
export function canvasGestureHidesChrome(
  gesture: { type: string; dragging?: boolean },
  distance: number,
): boolean {
  if (gesture.type === "comment") return false;
  if (gesture.type === "press") return gesture.dragging === true;
  return distance >= DRAG_THRESHOLD;
}

export type ResizeHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

export type ResizeResult = WorldRect & {
  /** Only the axes the gesture changed are written, keeping Fit/Fill on the other. */
  changed: { width: boolean; height: boolean };
};

/**
 * A box resized by dragging `handle` by (dx, dy) screen pixels. Alt resizes from the centre,
 * Shift keeps the aspect ratio; sizes never go under `minSize` design pixels.
 */
export function resizeGeometry(
  origin: WorldRect,
  handle: ResizeHandle,
  delta: Point,
  zoom: number,
  { alt, shift, minSize }: { alt: boolean; shift: boolean; minSize: number },
): ResizeResult {
  const west = handle.includes("w");
  const north = handle.includes("n");
  const horizontal = west || handle.includes("e");
  const vertical = north || handle.includes("s");
  const factor = alt ? 2 : 1;
  let width = horizontal
    ? origin.width + ((west ? -delta.x : delta.x) / zoom) * factor
    : origin.width;
  let height = vertical
    ? origin.height + ((north ? -delta.y : delta.y) / zoom) * factor
    : origin.height;
  if (shift && origin.width > 0 && origin.height > 0) {
    const ratio = origin.width / origin.height;
    if (
      !vertical ||
      (horizontal && Math.abs(width / origin.width) >= Math.abs(height / origin.height))
    )
      height = width / ratio;
    else width = height * ratio;
  }
  width = Math.max(minSize, width);
  height = Math.max(minSize, height);
  const x = alt
    ? origin.x + (origin.width - width) / 2
    : west
      ? origin.x + origin.width - width
      : origin.x;
  const y = alt
    ? origin.y + (origin.height - height) / 2
    : north
      ? origin.y + origin.height - height
      : origin.y;
  return {
    x,
    y,
    width,
    height,
    changed: { width: width !== origin.width, height: height !== origin.height },
  };
}

/** Where a dragged item's `left`/`top` (or frame x/y) lands: whole design pixels. */
export const dragPosition = (origin: Point, delta: Point, zoom: number): Point => ({
  x: Math.round(origin.x + delta.x / zoom),
  y: Math.round(origin.y + delta.y / zoom),
});

/** Shift while dragging: the move keeps to the axis it has travelled further along. */
export const constrainToAxis = (delta: Point): Point =>
  Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };

/** A delta turned into the axes of a layer rotated by `degrees`, so its handles resize along them. */
export function rotateDelta(delta: Point, degrees: number): Point {
  if (!degrees) return delta;
  const radians = (-degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: delta.x * cos - delta.y * sin, y: delta.x * sin + delta.y * cos };
}

/** The flex spacing handles: a padding side, or the gap along the main axis. */
export type SpacingHandle =
  | "padding-top"
  | "padding-right"
  | "padding-bottom"
  | "padding-left"
  | "gap";

/**
 * The value a spacing handle drag sets, in whole design pixels: padding grows as its handle
 * moves inward, the gap as its handle moves along the main axis. Never negative.
 */
export function spacingValue(
  origin: number,
  handle: SpacingHandle,
  delta: Point,
  row: boolean,
): number {
  const change =
    handle === "padding-left"
      ? delta.x
      : handle === "padding-right"
        ? -delta.x
        : handle === "padding-top"
          ? delta.y
          : handle === "padding-bottom"
            ? -delta.y
            : row
              ? delta.x
              : delta.y;
  return Math.max(0, Math.round(origin + change));
}

/** The drag chip: "↑ 1" for a step within the same layout, "↳ Card" for a new parent. */
function flowMoveLabel(
  frame: Pick<DesignFrame, "title" | "layers"> | undefined,
  index: LayerIndex,
  item: LayerItem,
  parentId: string | null,
  beforeId: string | undefined,
  row: boolean,
) {
  if ((index.parent.get(item.layerId) ?? null) !== parentId)
    return `↳ ${parentId ? layerLabel(index, parentId) : (frame?.title ?? "")}`;
  const siblings = elementChildren(
    index,
    frame?.layers.roots ?? [],
    parentId
      ? { kind: "layer", frameId: item.frameId, layerId: parentId }
      : { kind: "frame", frameId: item.frameId },
  );
  const from = siblings.indexOf(item.layerId);
  let to = beforeId ? siblings.indexOf(beforeId) : siblings.length;
  if (from < 0 || to < 0) return null;
  if (to > from) to -= 1;
  const steps = to - from;
  if (steps === 0) return null;
  const arrow = row ? (steps < 0 ? "←" : "→") : steps < 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(steps)}`;
}

/**
 * Where a dragged flow layer would land: the container under the pointer, and the
 * child it would precede along that container's main axis. The dragged subtree is skipped.
 */
export function resolveFlowDrop(
  editor: Pick<CanvasEditorApi, "elementFor" | "layers" | "frame">,
  viewport: HTMLElement,
  item: LayerItem,
  clientX: number,
  clientY: number,
): FlowDrop | null {
  const frameRoot = editor.elementFor({ kind: "frame", frameId: item.frameId });
  const dragged = editor.elementFor(item);
  if (!frameRoot || !dragged) return null;
  const shadow = frameRoot.getRootNode() as ShadowRoot;
  const origin = viewport.getBoundingClientRect();
  const index = editor.layers(item.frameId);
  const frame = editor.frame(item.frameId);
  const toScreen = (box: DOMRect): ScreenRect => ({
    x: box.left - origin.left,
    y: box.top - origin.top,
    width: box.width,
    height: box.height,
  });
  let parent: HTMLElement = frameRoot;
  for (const candidate of shadow.elementsFromPoint(clientX, clientY)) {
    if (!(candidate instanceof HTMLElement) || !frameRoot.contains(candidate)) continue;
    if (candidate === dragged || dragged.contains(candidate)) continue;
    const id = candidate.getAttribute(DESIGN_LAYER_ATTRIBUTE);
    if (!id) continue;
    const leaf =
      DESIGN_VOID_TAGS.has(candidate.localName) || (index ? isTextOnly(index, id) : false);
    parent = leaf ? (candidate.parentElement ?? frameRoot) : candidate;
    break;
  }
  if (parent !== frameRoot && !frameRoot.contains(parent)) parent = frameRoot;
  const parentId = parent === frameRoot ? null : parent.getAttribute(DESIGN_LAYER_ATTRIBUTE);
  if (parent !== frameRoot && !parentId) return null;
  const style = getComputedStyle(parent);
  const row = style.display.includes("flex") && style.flexDirection.startsWith("row");
  // Element, not HTMLElement: an inline SVG sibling is a flow layer like any other.
  const children = [...parent.children].filter(
    (child) =>
      child !== dragged && child.hasAttribute(DESIGN_LAYER_ATTRIBUTE) && !isFreePositioned(child),
  );
  const before = children.find((child) => {
    const box = child.getBoundingClientRect();
    return row ? clientX < box.left + box.width / 2 : clientY < box.top + box.height / 2;
  });
  const parentBox = toScreen(parent.getBoundingClientRect());
  const reference = before ?? children.at(-1);
  const refBox = reference ? toScreen(reference.getBoundingClientRect()) : null;
  const line: ScreenRect = refBox
    ? row
      ? {
          x: (before ? refBox.x : refBox.x + refBox.width) - 1,
          y: refBox.y,
          width: 2,
          height: refBox.height,
        }
      : {
          x: refBox.x,
          y: (before ? refBox.y : refBox.y + refBox.height) - 1,
          width: refBox.width,
          height: 2,
        }
    : {
        x: parentBox.x + 4,
        y: parentBox.y + 4,
        width: Math.max(8, parentBox.width - 8),
        height: 2,
      };
  const beforeId = before?.getAttribute(DESIGN_LAYER_ATTRIBUTE) ?? undefined;
  return {
    frameId: item.frameId,
    parentId,
    beforeId,
    line,
    container: parentBox,
    pointer: { x: clientX - origin.left, y: clientY - origin.top },
    label: index ? layerLabel(index, item.layerId) : "",
    move: index ? flowMoveLabel(frame, index, item, parentId, beforeId, row) : null,
  };
}

/** Whether a drop would leave the layer exactly where it is. */
export function isSameFlowPlace(
  editor: Pick<CanvasEditorApi, "layers" | "frame">,
  item: LayerItem,
  drop: Pick<FlowDrop, "parentId" | "beforeId">,
) {
  const index = editor.layers(item.frameId);
  const frame = editor.frame(item.frameId);
  if (!index || !frame) return true;
  const { parentId, siblings } = layerSiblings(index, frame.layers.roots, item.layerId);
  if (parentId !== drop.parentId) return false;
  const at = siblings.indexOf(item.layerId);
  return siblings[at + 1] === drop.beforeId || drop.beforeId === item.layerId;
}

/** Where a freely placed layer dragged over another container would be reparented. */
export type ParentDrop = {
  parentId: string | null;
  /** The new parent's box (screen pixels, viewport-local) and the drag chip ("↳ Card"). */
  container: ScreenRect;
  label: string;
};

/**
 * The container under the pointer for a dragged absolute layer (reparenting settles when a
 * drag ends): the innermost element there that can hold layers, outside the dragged subtree,
 * or the frame itself. Null when that is the layer's own parent.
 */
export function resolveParentDrop(
  editor: Pick<CanvasEditorApi, "elementFor" | "layers" | "frame">,
  viewport: HTMLElement,
  item: LayerItem,
  clientX: number,
  clientY: number,
): ParentDrop | null {
  const frameRoot = editor.elementFor({ kind: "frame", frameId: item.frameId });
  const dragged = editor.elementFor(item);
  const index = editor.layers(item.frameId);
  if (!frameRoot || !dragged || !index) return null;
  const shadow = frameRoot.getRootNode() as ShadowRoot;
  let parent: HTMLElement = frameRoot;
  let parentId: string | null = null;
  for (const candidate of shadow.elementsFromPoint(clientX, clientY)) {
    if (!(candidate instanceof HTMLElement) || !frameRoot.contains(candidate)) continue;
    if (candidate === dragged || dragged.contains(candidate)) continue;
    const id = candidate.getAttribute(DESIGN_LAYER_ATTRIBUTE);
    if (!id || DESIGN_VOID_TAGS.has(candidate.localName) || isTextOnly(index, id)) continue;
    parent = candidate;
    parentId = id;
    break;
  }
  if ((index.parent.get(item.layerId) ?? null) === parentId) return null;
  const origin = viewport.getBoundingClientRect();
  const box = parent.getBoundingClientRect();
  return {
    parentId,
    container: {
      x: box.left - origin.left,
      y: box.top - origin.top,
      width: box.width,
      height: box.height,
    },
    label: `↳ ${parentId ? layerLabel(index, parentId) : (editor.frame(item.frameId)?.title ?? "")}`,
  };
}

/**
 * The `left`/`top` that keep `element` where it is on screen once it is a child of `parent`:
 * measured from the padding box of the parent's containing block for absolute children (the
 * parent itself when it is positioned, else its nearest positioned ancestor, else the frame).
 */
export function offsetInParent(
  element: Element,
  parent: Element,
  frameRoot: HTMLElement,
  zoom: number,
): Point {
  let block: Element = parent;
  while (block !== frameRoot && getComputedStyle(block).position === "static")
    block = block.parentElement ?? frameRoot;
  const box = element.getBoundingClientRect();
  const outer = block.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    x: Math.round(
      (box.left - outer.left) / zoom -
        block.clientLeft -
        (Number.parseFloat(style.marginLeft) || 0),
    ),
    y: Math.round(
      (box.top - outer.top) / zoom - block.clientTop - (Number.parseFloat(style.marginTop) || 0),
    ),
  };
}
