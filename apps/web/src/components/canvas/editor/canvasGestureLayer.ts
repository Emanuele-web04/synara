// FILE: canvasGestureLayer.ts
// Purpose: What a gesture draws while the pointer moves (the marquee and what it would select,
//          a layout drop bar, a shape being drawn), written straight to the DOM so a gesture
//          never re-renders the canvas. Screen pixels, relative to the viewport.
// Layer: Canvas editor UI (imperative)
// Exports: createCanvasGestureLayer, CanvasGestureLayer, FlowDrop

import { fillMeasureChip, type MeasureChipContent } from "./CanvasMeasureChip";
import type { Point, ScreenRect } from "./canvasMeasure";

/** Where a dragged flow layer would land, and how its drag chip reads. */
export type FlowDrop = {
  frameId: string;
  parentId: string | null;
  beforeId: string | undefined;
  line: ScreenRect;
  container: ScreenRect;
  /** The pointer, where the drag chip follows it. */
  pointer: Point;
  /** The dragged layer's name and where it would go: a step in its layout or a new parent. */
  label: string;
  move: string | null;
};

const MARQUEE_CLASS_NAME = "absolute border border-muted-foreground bg-neutral-900/6";
const PREVIEW_BOX_CLASS_NAME = "absolute border border-muted-foreground";
const DRAW_CLASS_NAME = "absolute border border-(--canvas-accent) bg-white/40";
const DROP_LINE_CLASS_NAME = "absolute bg-(--canvas-drop)";
const CONTAINER_CLASS_NAME = "absolute border border-(--canvas-accent)";
const DROP_END_CLASS_NAME =
  "absolute size-1.5 rounded-full border-[1.5px] border-(--canvas-drop) bg-white";

const place = (element: HTMLElement, rect: ScreenRect) => {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
};

const hide = (...elements: HTMLElement[]) => {
  for (const element of elements) element.remove();
};

export type CanvasGestureLayer = ReturnType<typeof createCanvasGestureLayer>;

export function createCanvasGestureLayer(container: HTMLElement) {
  const owner = container.ownerDocument;
  const make = (className: string) => {
    const element = owner.createElement("div");
    element.className = className;
    return element;
  };
  const marquee = make(MARQUEE_CLASS_NAME);
  const draw = make(DRAW_CLASS_NAME);
  const dropLine = make(DROP_LINE_CLASS_NAME);
  const dropEnds = [make(DROP_END_CLASS_NAME), make(DROP_END_CLASS_NAME)];
  const chip = make("");
  const target = make(CONTAINER_CLASS_NAME);
  const boxes: HTMLElement[] = [];
  const show = (...elements: HTMLElement[]) => {
    for (const element of elements) if (element.parentNode !== container) container.append(element);
  };
  const showChip = (content: MeasureChipContent, at: Point) => {
    fillMeasureChip(chip, content);
    chip.style.left = `${at.x}px`;
    chip.style.top = `${at.y}px`;
    show(chip);
  };
  return {
    /** The marquee, the boxes it would select and, when it selects any, their count. */
    marquee(
      rect: ScreenRect | null,
      picked: readonly ScreenRect[] = [],
      count?: MeasureChipContent,
      pointer?: Point,
    ) {
      if (!rect) return hide(marquee, chip, ...boxes.splice(0));
      while (boxes.length < picked.length) boxes.push(make(PREVIEW_BOX_CLASS_NAME));
      hide(...boxes.splice(picked.length));
      picked.forEach((box, at) => place(boxes[at]!, box));
      show(...boxes, marquee);
      place(marquee, rect);
      if (count && pointer && picked.length)
        showChip(count, { x: pointer.x + 15, y: pointer.y + 11 });
      else hide(chip);
    },
    /** A layout move's drop bar, its end dots and the drag chip. */
    drop(drop: FlowDrop | null) {
      if (!drop) return hide(dropLine, ...dropEnds, chip);
      const { line } = drop;
      place(dropLine, line);
      const across = line.width > line.height;
      dropEnds.forEach((end, at) => {
        end.style.left = `${(across ? line.x + line.width * at : line.x + line.width / 2) - 3}px`;
        end.style.top = `${(across ? line.y + line.height / 2 : line.y + line.height * at) - 3}px`;
      });
      show(dropLine, ...dropEnds);
      showChip(
        { label: drop.label, meta: drop.move ? [drop.move] : [] },
        { x: drop.pointer.x + 12, y: drop.pointer.y + 18 },
      );
    },
    /** The container a dragged absolute layer would move into, and its "↳ Card" chip. */
    container(rect: ScreenRect | null, label?: string, pointer?: Point) {
      if (!rect) return hide(target, chip);
      place(target, rect);
      show(target);
      if (label && pointer) showChip({ label }, { x: pointer.x + 12, y: pointer.y + 18 });
    },
    /** A value beside the pointer (a spacing handle's padding or gap). */
    value(content: MeasureChipContent | null, pointer?: Point) {
      if (!content || !pointer) return hide(chip);
      showChip(content, { x: pointer.x + 12, y: pointer.y + 18 });
    },
    /** The frame or shape being drawn. */
    draw(rect: ScreenRect | null) {
      if (!rect) return hide(draw);
      place(draw, rect);
      show(draw);
    },
    clear() {
      hide(marquee, draw, dropLine, ...dropEnds, chip, target, ...boxes.splice(0));
    },
  };
}
