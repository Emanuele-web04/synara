// FILE: TerminalWorkspaceTabs.tsx
// Purpose: Renders the top-level workspace switcher between terminal and chat surfaces.
// Layer: Chat workspace chrome
// Depends on: terminal workspace store layout state and shared className helpers.
//
// Note: the two raw <button>s are intentional — they are tabs, not shadcn
// Buttons. Tab-shape rendering (rounded-top corners, no bottom border on the
// active tab, z-index stacking) doesn't fit the Button taxonomy.

import { cn } from "~/lib/utils";

import { CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME } from "./chat/chatHeaderControls";
import TerminalActivityIndicator from "./terminal/TerminalActivityIndicator";
import { type ThreadTerminalWorkspaceLayout, type ThreadTerminalWorkspaceTab } from "../types";

interface TerminalWorkspaceTabsProps {
  activeTab: ThreadTerminalWorkspaceTab;
  isWorking: boolean;
  terminalHasRunningActivity: boolean;
  terminalCount: number;
  workspaceLayout: ThreadTerminalWorkspaceLayout;
  onSelectTab: (tab: ThreadTerminalWorkspaceTab) => void;
}

export default function TerminalWorkspaceTabs({
  activeTab,
  isWorking,
  terminalHasRunningActivity,
  terminalCount,
  workspaceLayout,
  onSelectTab,
}: TerminalWorkspaceTabsProps) {
  // Terminal-only workspaces already expose the per-terminal tab strip below,
  // so the chat/terminal switcher would only duplicate chrome and reintroduce chat.
  if (terminalCount <= 1 || workspaceLayout === "terminal-only") {
    return null;
  }

  const tabClassName =
    "group relative -mb-px inline-flex h-7 shrink-0 items-center rounded-t-[10px] border border-b-0 px-3 text-ui-sm leading-snug transition-colors";

  return (
    <div
      className={cn("relative bg-muted/10 px-3 sm:px-5", CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME)}
    >
      <div className="flex min-w-0 items-end gap-1.5 overflow-x-auto pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          aria-pressed={activeTab === "terminal"}
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
          <span>Terminal</span>
          <span className="ml-1.5 font-mono text-ui-xs text-muted-foreground">{terminalCount}</span>
          {terminalHasRunningActivity ? (
            <TerminalActivityIndicator className="ml-1.5 text-foreground/75" />
          ) : null}
        </button>
        <button
          type="button"
          aria-pressed={activeTab === "chat"}
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
          <span>Chat</span>
          {isWorking ? (
            <TerminalActivityIndicator state="running" className="ml-1.5 text-foreground/75" />
          ) : null}
        </button>
      </div>
    </div>
  );
}
