import { cn } from "~/lib/utils";

import { type ThreadTerminalWorkspaceTab } from "../types";

interface TerminalWorkspaceTabsProps {
  activeTab: ThreadTerminalWorkspaceTab;
  isWorking: boolean;
  terminalCount: number;
  onSelectTab: (tab: ThreadTerminalWorkspaceTab) => void;
}

export default function TerminalWorkspaceTabs({
  activeTab,
  isWorking,
  terminalCount,
  onSelectTab,
}: TerminalWorkspaceTabsProps) {
  if (terminalCount <= 1) {
    return null;
  }

  const tabClassName =
    "group relative -mb-px inline-flex h-7 shrink-0 items-center rounded-t-[10px] border border-b-0 px-3 text-xs transition-colors";

  return (
    <div className="relative border-b border-border/70 bg-muted/10 px-3 sm:px-5">
      <div className="flex min-w-0 items-end gap-1.5 overflow-x-auto pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          className={cn(
            tabClassName,
            activeTab === "terminal"
              ? "z-[1] border-border/70 bg-background text-foreground"
              : "border-transparent bg-transparent text-muted-foreground hover:bg-background/55 hover:text-foreground",
          )}
          onClick={() => {
            onSelectTab("terminal");
          }}
        >
          <span className="font-mono tracking-wide">Terminal</span>
          <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
            {terminalCount}
          </span>
        </button>
        <button
          type="button"
          className={cn(
            tabClassName,
            activeTab === "chat"
              ? "z-[1] border-border/70 bg-background text-foreground"
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
      </div>
    </div>
  );
}
