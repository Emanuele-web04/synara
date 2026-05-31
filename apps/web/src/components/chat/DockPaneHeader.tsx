// FILE: DockPaneHeader.tsx
// Purpose: Compact title bar for lightweight right-dock panes (e.g. source control)
//          — a title, an optional action cluster, and the standard chrome close
//          affordance. Distinct from DiffPanelShell's heavier draggable titlebar.
// Layer: Chat right-dock UI primitives

import { type ReactNode } from "react";

import { XIcon } from "~/lib/icons";
import { IconButton } from "../ui/icon-button";

export function DockPaneHeader(props: {
  title: ReactNode;
  actions?: ReactNode;
  onClose?: (() => void) | undefined;
  closeLabel?: string;
}) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/70 px-2">
      <span className="text-[12px] font-semibold text-foreground">{props.title}</span>
      <div className="ml-auto flex items-center gap-0.5">
        {props.actions}
        {props.onClose ? (
          <IconButton
            size="icon-xs"
            variant="chrome"
            label={props.closeLabel ?? "Close panel"}
            onClick={props.onClose}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </header>
  );
}
