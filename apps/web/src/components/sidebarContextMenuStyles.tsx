// FILE: sidebarContextMenuStyles.tsx
// Purpose: Shared chrome for sidebar right-click menus (projects, spaces).
// Layer: Sidebar UI styling
// Why: The project context menu and the Space tab context menu are the same object to a user —
//      a right-click menu on a sidebar item. They were styled independently and drifted (panel
//      width, item colour, icon slot). Both now read their chrome from here.

import type { LucideIcon } from "~/lib/icons";

export const SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME = "w-48 min-w-48";

export const SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME =
  "text-[var(--color-text-foreground)] data-highlighted:text-[var(--color-text-foreground)]";

export const SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME =
  "inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)] [&>svg]:size-3.5 [&>[data-slot=central-icon]]:size-3.5";

/** Leading glyph slot; keeps every menu icon on the same box and secondary tone. */
export function SidebarContextMenuIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className={SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME}>
      <Icon aria-hidden="true" />
    </span>
  );
}
