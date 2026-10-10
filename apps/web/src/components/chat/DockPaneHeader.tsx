// FILE: DockPaneHeader.tsx
// Purpose: Title bar for lightweight right-dock panes (e.g. source control) — a title,
//          an optional leading icon, action cluster, and the standard chrome close affordance.
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
  leadingIcon?: ReactNode;
  actions?: ReactNode;
  onClose?: (() => void) | undefined;
  closeLabel?: string;
  /** Embedded in a shell that already owns the header height, padding, and divider. */
  variant?: "standalone" | "embedded";
}) {
  return (
    <header
      className={cn(
        "min-w-0 gap-1.5",
        props.variant === "embedded"
          ? "flex h-full w-full items-center"
          : cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "px-4"),
      )}
    >
      {props.leadingIcon ? (
        <span aria-hidden="true" className="flex shrink-0 items-center text-muted-foreground">
          {props.leadingIcon}
        </span>
      ) : null}
      <div className="min-w-0 truncate text-ui-lg font-medium tracking-[-0.01em] text-foreground">
        {props.title}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
