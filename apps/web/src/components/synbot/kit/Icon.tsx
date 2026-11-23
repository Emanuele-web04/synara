// FILE: Icon.tsx
// Purpose: The one way the SynBot kit draws icons (ported from HoloBot's packages/ui Icon.tsx):
//          Hugeicons free, stroke rounded (MIT, kit/NOTICES.md), 24x24 SVGs in ./icons, drawn in
//          the current text color.
// Layer: SynBot kit
// Exports: ICONS, IconName, IconSize, Icon

import approve from "./icons/approve.svg?raw";
import arrowDown from "./icons/arrow-down.svg?raw";
import arrowLeft from "./icons/arrow-left.svg?raw";
import arrowRight from "./icons/arrow-right.svg?raw";
import branch from "./icons/branch.svg?raw";
import check from "./icons/check.svg?raw";
import chevronDown from "./icons/chevron-down.svg?raw";
import close from "./icons/close.svg?raw";
import copyIcon from "./icons/copy.svg?raw";
import deny from "./icons/deny.svg?raw";
import file from "./icons/file.svg?raw";
import folder from "./icons/folder.svg?raw";
import loading from "./icons/loading.svg?raw";
import more from "./icons/more.svg?raw";
import plus from "./icons/plus.svg?raw";
import search from "./icons/search.svg?raw";
import send from "./icons/send.svg?raw";
import settings from "./icons/settings.svg?raw";
import sidebarRight from "./icons/sidebar-right.svg?raw";
import star from "./icons/star.svg?raw";
import stop from "./icons/stop.svg?raw";
import undo from "./icons/undo.svg?raw";

/** Every icon the SynBot page draws, by name (the file name in `icons/`). */
export const ICONS = {
  approve,
  "arrow-down": arrowDown,
  "arrow-left": arrowLeft,
  "arrow-right": arrowRight,
  branch,
  check,
  "chevron-down": chevronDown,
  close,
  copy: copyIcon,
  deny,
  file,
  folder,
  loading,
  more,
  plus,
  search,
  send,
  settings,
  "sidebar-right": sidebarRight,
  star,
  stop,
  undo,
} as const;

export type IconName = keyof typeof ICONS;

/** lg: alone in an empty slot; md: buttons; sm: chips and inline text; xs: inside badges. */
export type IconSize = "lg" | "md" | "sm" | "xs";

export function Icon({ name, size = "md" }: { readonly name: IconName; readonly size?: IconSize }) {
  return (
    <span
      className={`hb-icon hb-icon--${size}`}
      aria-hidden
      // Static SVG files bundled with the app, never user content.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
