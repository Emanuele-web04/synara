// FILE: pin.tsx
// Purpose: Shared semantic helpers for pin/unpin affordances.
// Layer: web UI utility
// Exports: pinActionLabel, PinStatusIcon
// Why: The "Pin <target>" / "Unpin <target>" verb policy and the "solid glyph only
//      when pinned, outline otherwise" rule were duplicated (and drifting) across
//      the sidebar project/thread rows, the project hover card, and the context
//      menus. Centralizing both keeps every pin control's wording and glyph aligned.

import type { SVGProps } from "react";
import { PinFilledIcon, PinIcon } from "./icons";

/** Accessible verb for a pin toggle: "Pin <target>" when unpinned, "Unpin <target>" when pinned. */
export function pinActionLabel(target: string, pinned: boolean): string {
  return `${pinned ? "Unpin" : "Pin"} ${target}`;
}

// State-reflecting pin glyph: the solid fill-set pin once pinned, the outline pin
// otherwise. Outline reads as a quiet "pin me" affordance (e.g. revealed on row
// hover); the fill confirms the pinned state. Single source so no surface drifts.
export function PinStatusIcon({ pinned, ...props }: SVGProps<SVGSVGElement> & { pinned: boolean }) {
  const Icon = pinned ? PinFilledIcon : PinIcon;
  return <Icon {...props} />;
}
