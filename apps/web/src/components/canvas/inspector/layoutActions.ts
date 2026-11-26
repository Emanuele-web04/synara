// FILE: layoutActions.ts
// Purpose: The Layout section's selection actions, shared by its buttons and the canvas's
//          keyboard: align and distribute freely placed items, resize to fit or fill, and
//          resize by a step (⌘ arrows). Each acts on an inspector model of the selection.
// Layer: Canvas editor logic
// Exports: alignSelection, distributeSelection, resizeSelectionTo, resizeSelectionBy,
//          isFreeformSelection

import type { CanvasFrameLayoutPatch } from "@synara/contracts";
import {
  DESIGN_FRAME_MAX_HEIGHT,
  DESIGN_FRAME_MAX_WIDTH,
  DESIGN_FRAME_MIN_SIZE,
} from "@synara/contracts";
import {
  alignBoxes,
  clamp,
  distributeBoxes,
  insetExpansion,
  sizingPatch,
  type AlignMode,
  type Box,
  type PinAxis,
  type Shift,
  type SizingAxis,
} from "./inspectorValues";
import type { InspectorModel, InspectorTarget } from "./useInspectorModel";
import { insetOf, positionPatch, sizeInputPatch, sizingModeOf } from "./layoutPatches";

const isAbsolute = (target: InspectorTarget) =>
  target.computed.position === "absolute" || target.computed.position === "fixed";

/** Several frames, or several absolutely placed layers: the items align and distribute. */
export function isFreeformSelection(model: InspectorModel): boolean {
  const frames = model.targets.filter((target) => target.isFrame);
  const layers = model.targets.filter((target) => !target.isFrame);
  return (
    model.targets.length > 1 &&
    ((frames.length > 0 && layers.length === 0) ||
      (frames.length === 0 && layers.every(isAbsolute)))
  );
}

/** A layer's border box in world pixels (frames add their position on the board). */
function worldBox(model: InspectorModel, target: InspectorTarget): Box {
  if (target.isFrame) {
    const { x, y, width, height } = target.frame;
    return { x, y, width, height };
  }
  const root = model.editor.elementFor({ kind: "frame", frameId: target.frame.id });
  const rootRect = root?.getBoundingClientRect();
  const rect = target.element.getBoundingClientRect();
  const scale = rootRect && rootRect.width > 0 ? rootRect.width / target.frame.width : 1;
  return {
    x: target.frame.x + (rect.left - (rootRect?.left ?? 0)) / scale,
    y: target.frame.y + (rect.top - (rootRect?.top ?? 0)) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}

/** Moves each target by its shift: frames through the layout, layers through their insets. */
function applyShifts(model: InspectorModel, shifts: readonly Shift[]) {
  const { targets, editor } = model;
  if (targets.every((target) => target.isFrame)) {
    const frames: CanvasFrameLayoutPatch[] = targets.map((target, index) => ({
      id: target.frame.id,
      x: Math.round(target.frame.x + shifts[index]!.dx),
      y: Math.round(target.frame.y + shifts[index]!.dy),
    }));
    return editor.run({ kind: "layout", frames }).then(() => undefined);
  }
  const byTarget = new Map(targets.map((target, index) => [target, shifts[index]!]));
  return model.commit((target) => {
    const shift = byTarget.get(target);
    if (!shift) return null;
    return {
      ...insetExpansion(target.declared, target.specified),
      ...(shift.dx !== 0 ? positionPatch(target, "x", insetOf(target, "x").start + shift.dx) : {}),
      ...(shift.dy !== 0 ? positionPatch(target, "y", insetOf(target, "y").start + shift.dy) : {}),
    };
  });
}

/** Lines the freely placed items up on one edge or centre. Nothing happens otherwise. */
export function alignSelection(model: InspectorModel, mode: AlignMode): Promise<void> {
  if (model.readOnly || !isFreeformSelection(model)) return Promise.resolve();
  const boxes = model.targets.map((target) => worldBox(model, target));
  return applyShifts(model, alignBoxes(boxes, mode));
}

/** Equal gaps between the first and last item along `axis` (three items or more). */
export function distributeSelection(model: InspectorModel, axis: PinAxis): Promise<void> {
  if (model.readOnly || !isFreeformSelection(model) || model.targets.length < 3)
    return Promise.resolve();
  const boxes = model.targets.map((target) => worldBox(model, target));
  return applyShifts(model, distributeBoxes(boxes, axis));
}

/** Resize to fit (the content) or fill (the parent), on both axes or one. Layers only. */
export function resizeSelectionTo(
  model: InspectorModel,
  mode: "fit" | "fill",
  axes: readonly SizingAxis[] = ["width", "height"],
): Promise<void> {
  if (model.readOnly || model.targets.some((target) => target.isFrame)) return Promise.resolve();
  return model.commit((target) =>
    Object.assign(
      {},
      ...axes.map((axis) =>
        sizingPatch({
          axis,
          mode,
          current: sizingModeOf(target, axis),
          size: target.size[axis],
          parentSize: target.parent?.[axis] ?? 0,
          parent: target.parent,
        }),
      ),
    ),
  );
}

/** ⌘ arrows: width and height grow or shrink by a step; layers take a fixed size. */
export function resizeSelectionBy(model: InspectorModel, dw: number, dh: number): Promise<void> {
  if (model.readOnly || model.targets.length === 0) return Promise.resolve();
  const frames = model.targets.filter((target) => target.isFrame);
  const layers = model.targets.filter((target) => !target.isFrame);
  return model.editor.batch(async () => {
    if (frames.length)
      await model.editor.run({
        kind: "layout",
        frames: frames.map((target) => ({
          id: target.frame.id,
          width: clamp(target.frame.width + dw, DESIGN_FRAME_MIN_SIZE, DESIGN_FRAME_MAX_WIDTH),
          height: clamp(target.frame.height + dh, DESIGN_FRAME_MIN_SIZE, DESIGN_FRAME_MAX_HEIGHT),
        })),
      });
    if (layers.length)
      await model.commit(
        (target) => ({
          ...(dw !== 0
            ? sizeInputPatch(target, "width", {
                kind: "length",
                value: Math.max(0, Math.round(target.size.width) + dw),
                unit: "px",
              })
            : {}),
          ...(dh !== 0
            ? sizeInputPatch(target, "height", {
                kind: "length",
                value: Math.max(0, Math.round(target.size.height) + dh),
                unit: "px",
              })
            : {}),
        }),
        layers,
      );
  });
}
