// FILE: touchTargetStyles.ts
// Purpose: Coarse-pointer hit areas for compact controls, drawn as a transparent ::after so
//          the control keeps its size on screen while a thumb gets the 44px it needs.
// Layer: UI style tokens

const COARSE_HIT_AREA_BASE_CLASS_NAME =
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0";

/** For controls 28px tall or more (pills, segmented toggles). */
export const COARSE_HIT_AREA_CLASS_NAME = `${COARSE_HIT_AREA_BASE_CLASS_NAME} pointer-coarse:after:-inset-y-2`;

/** For text-height controls of 16-27px (inline links, count tabs). */
export const COARSE_HIT_AREA_TALL_CLASS_NAME = `${COARSE_HIT_AREA_BASE_CLASS_NAME} pointer-coarse:after:-inset-y-3.5`;

/** Focus ring for hand-rolled buttons that do not go through the Button primitive. */
export const FOCUS_RING_CLASS_NAME =
  "outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]";
