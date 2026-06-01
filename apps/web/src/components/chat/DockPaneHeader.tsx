// FILE: DockPaneHeader.tsx
// Purpose: Title bar for lightweight right-dock panes (e.g. source control) — a title,
//          an optional action cluster, and the standard chrome close affordance.
//          Shares the dock header height (CHAT_SURFACE_HEADER_HEIGHT_CLASS) and chrome
//          button footprint (DOCK_HEADER_ICON_BUTTON_CLASS) with the tab strip and the
//          DiffPanelShell/BrowserPanel headers so every dock surface lines up.
// Layer: Chat right-dock UI primitives

import { type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { XIcon } from "~/lib/icons";
import { IconButton } from "../ui/icon-button";
import {
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  DOCK_HEADER_ICON_BUTTON_CLASS,
} from "./chatHeaderControls";

export function DockPaneHeader(props: {
  title: ReactNode;
  actions?: ReactNode;
  onClose?: (() => void) | undefined;
  closeLabel?: string;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-border px-4",
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
      )}
    >
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
