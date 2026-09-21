// the Pin/Unpin verb policy and solid-only-when-pinned rule were duplicated and drifting across sidebar rows, hover card, and context menus — centralized

import type { SVGProps } from "react";
import { PinFilledIcon, PinIcon } from "./icons";

export function pinActionLabel(target: string, pinned: boolean): string {
  return `${pinned ? "Unpin" : "Pin"} ${target}`;
}

// state-reflecting pin: solid fill once pinned, outline otherwise (outline = quiet pin-me affordance on hover); single source so no surface drifts
export function PinStatusIcon({ pinned, ...props }: SVGProps<SVGSVGElement> & { pinned: boolean }) {
  const Icon = pinned ? PinFilledIcon : PinIcon;
  return <Icon {...props} />;
}
