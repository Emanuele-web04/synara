// FILE: SidebarPanelTitle.tsx
// Purpose: Title row at the top of a sidebar panel ("Settings", "Automations"), aligned with
//          the thread surface picker's title so every panel opens on the same baseline.
// Layer: Sidebar UI primitive

import type { ReactNode } from "react";

/** Panel title type: display face at the title size (titles may use a fixed size). */
export const SIDEBAR_PANEL_TITLE_CLASS_NAME =
  "font-display min-w-0 truncate text-[17px] text-foreground";

export function SidebarPanelTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-1 pt-3 pb-1 pr-2.5 pl-1.5">
      <h2 className="flex h-8 min-w-0 items-center px-2.5">
        <span className={SIDEBAR_PANEL_TITLE_CLASS_NAME}>{title}</span>
      </h2>
      {children ? <div className="ml-auto flex items-center gap-1.5">{children}</div> : null}
    </div>
  );
}
