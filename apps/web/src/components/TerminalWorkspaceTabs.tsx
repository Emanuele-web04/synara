// FILE: TerminalWorkspaceTabs.tsx
// Purpose: Renders the top-level workspace switcher between terminal and chat surfaces.
// Layer: Chat workspace chrome
// Depends on: terminal workspace store layout state and shared className helpers.
//
// Note: the two raw <button>s are intentional — they are tabs, not shadcn
// Buttons. Tab-shape rendering (rounded-top corners, no bottom border on the
// active tab, z-index stacking) doesn't fit the Button taxonomy.

import { useRef } from "react";

import { useHorizontalWheelScroll } from "./chat/chatHeaderControls";
import { IconButton } from "./ui/icon-button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import TerminalActivityIndicator from "./terminal/TerminalActivityIndicator";
import { type ThreadTerminalWorkspaceLayout, type ThreadTerminalWorkspaceTab } from "../types";

interface TerminalWorkspaceTabsProps {
  activeTab: ThreadTerminalWorkspaceTab;
  isWorking: boolean;
  terminalHasRunningActivity: boolean;
  workspaceLayout: ThreadTerminalWorkspaceLayout;
  onClose: () => void;
  onSelectTab: (tab: ThreadTerminalWorkspaceTab) => void;
}

export default function TerminalWorkspaceTabs({
  activeTab,
  isWorking,
  terminalHasRunningActivity,
  workspaceLayout,
  onSelectTab,
  onClose,
}: TerminalWorkspaceTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(stripRef);
  const tabClassName =
    "group relative -mb-px inline-flex h-7 shrink-0 items-center rounded-t-[10px] border border-b-0 px-3 text-ui leading-snug transition-colors";

  return (
    <div className="relative border-b border-border/70 bg-muted/10 px-3 sm:px-5">
      <div
        ref={stripRef}
        data-testid="terminal-workspace-tab-strip"
        className="flex min-w-0 items-end gap-1.5 overflow-x-auto pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <button
          type="button"
          className={cn(
            tabClassName,
            activeTab === "terminal"
              ? "z-[1] border-border/70 bg-[var(--composer-surface)] text-foreground"
              : "border-transparent bg-transparent text-muted-foreground hover:bg-background/55 hover:text-foreground",
          )}
          onClick={() => {
            onSelectTab("terminal");
          }}
        >
          <span className="font-mono tracking-wide">Terminal</span>
          {terminalHasRunningActivity ? (
            <TerminalActivityIndicator className="ml-1.5 text-foreground/75" />
          ) : null}
        </button>
        {workspaceLayout === "both" ? (
          <button
            type="button"
            className={cn(
              tabClassName,
              activeTab === "chat"
                ? "z-[1] border-border/70 bg-[var(--composer-surface)] text-foreground"
                : "border-transparent bg-transparent text-muted-foreground hover:bg-background/55 hover:text-foreground",
            )}
            onClick={() => {
              onSelectTab("chat");
            }}
          >
            <span className="font-mono tracking-wide">Chat</span>
            {isWorking ? (
              <span className="ml-1.5 inline-flex size-1.5 rounded-full bg-emerald-500/80" />
            ) : null}
          </button>
        ) : null}
        <IconButton
          label="Close terminal"
          tooltip="Close terminal"
          onClick={onClose}
          size="icon-xs"
          variant="chrome"
        >
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}
