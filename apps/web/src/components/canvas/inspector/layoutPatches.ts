// FILE: layoutPatches.ts
// Purpose: Style patches for a layer's position and size, read from its inspector target: the
//          used insets, the pin an inset keeps, the sizing mode, and the patch a typed size
//          writes. Shared by the Layout section and the keyboard's layout actions.
// Layer: Canvas editor logic
// Exports: insetOf, pinOf, containerSize, positionPatch, sizingModeOf, sizeInputPatch

import {
  formatLength,
  parsePx,
  pinnedPositionPatch,
  readPin,
  readSizingMode,
  sizingPatch,
  type CssInput,
  type Pin,
  type PinAxis,
  type SizingAxis,
  type SizingMode,
  type StylePatch,
} from "./inspectorValues";
import type { InspectorTarget } from "./useInspectorModel";

/** The used insets of one axis, as computed (px). */
export function insetOf(target: InspectorTarget, axis: PinAxis) {
  const [start, end] = axis === "x" ? (["left", "right"] as const) : (["top", "bottom"] as const);
  return {
    start:
      parsePx(target.computed[start]) ?? (axis === "x" ? target.offset.left : target.offset.top),
    end: parsePx(target.computed[end]) ?? 0,
  };
}

export const pinOf = (target: InspectorTarget, axis: PinAxis): Pin =>
  axis === "x"
    ? readPin({
        start: target.specified("left"),
        end: target.specified("right"),
        size: target.specified("width"),
      })
    : readPin({
        start: target.specified("top"),
        end: target.specified("bottom"),
        size: target.specified("height"),
      });

export const containerSize = (target: InspectorTarget, axis: PinAxis) =>
  (axis === "x" ? target.containing?.width : target.containing?.height) ??
  (axis === "x" ? target.parent?.width : target.parent?.height) ??
  0;

/** Moves a layer's start edge to `next` along `axis`, through the inset its pin keeps. */
export function positionPatch(target: InspectorTarget, axis: PinAxis, next: number): StylePatch {
  const inset = insetOf(target, axis);
  return pinnedPositionPatch({
    axis,
    pin: pinOf(target, axis),
    start: inset.start,
    end: inset.end,
    container: containerSize(target, axis),
    next,
  });
}

export function sizingModeOf(target: InspectorTarget, axis: SizingAxis): SizingMode {
  return readSizingMode({
    axis,
    declared: target.declared.get(axis),
    display: target.computed.display,
    position: target.computed.position,
    flexGrow: Number(target.computed["flex-grow"]) || 0,
    alignSelf: target.computed["align-self"],
    parent: target.parent,
  });
}

export function sizeInputPatch(
  target: InspectorTarget,
  axis: SizingAxis,
  input: CssInput,
): StylePatch {
  const current = sizingModeOf(target, axis);
  const base = {
    axis,
    current,
    size: target.size[axis],
    parentSize: target.parent?.[axis] ?? 0,
    parent: target.parent,
  };
  if (input.kind === "keyword") {
    if (input.keyword === "fill") return sizingPatch({ ...base, mode: "fill" });
    if (input.keyword === "auto") {
      const cleared = sizingPatch({ ...base, mode: "fit" });
      return { ...cleared, [axis]: null };
    }
    return sizingPatch({ ...base, mode: "fit" });
  }
  if (input.unit === "%") return sizingPatch({ ...base, mode: "relative", value: input.value });
  const patch = sizingPatch({ ...base, mode: "fixed", value: input.value });
  if (input.unit !== "px") patch[axis] = formatLength(input.value, input.unit);
  return patch;
}
