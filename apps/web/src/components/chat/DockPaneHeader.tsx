// FILE: DockPaneHeader.tsx
// Purpose: Title bar for lightweight right-dock panes (e.g. source control) — a title,
//          an optional action cluster, and the standard chrome close affordance.
//          Shares the standard chrome-bar row (CHAT_SURFACE_HEADER_ROW_CLASS_NAME — height
//          + bottom hairline) and the chrome button footprint (DOCK_HEADER_ICON_BUTTON_CLASS)
//          with the tab strip and the DiffPanelShell/BrowserPanel headers so every dock
//          surface lines up.
// Layer: Chat right-dock UI primitives

import { type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { XIcon } from "~/lib/icons";
import { IconButton } from "../ui/icon-button";
import {
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
} from "./chatHeaderControls";

export function DockPaneHeader(props: {
  title: ReactNode;
  actions?: ReactNode;
  onClose?: (() => void) | undefined;
  closeLabel?: string;
}) {
  return (
    <header className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "gap-1 px-4")}>
      <span className="text-[13px] font-medium tracking-[-0.01em] text-foreground">
        {props.title}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        {props.actions}
        {props.onClose ? (
          <IconButton
            size="icon-xs"
            variant="chrome"
            label={props.closeLabel ?? "Close panel"}
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            onClick={props.onClose}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </header>
  );
}
