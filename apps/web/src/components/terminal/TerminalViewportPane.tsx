// FILE: TerminalViewportPane.tsx
// Purpose: Renders the active terminal viewport area in split or single-pane mode.
// Layer: Terminal presentation components
// Depends on: caller-provided viewport renderer so xterm lifecycle can stay external.

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

interface TerminalViewportPaneProps {
  isSplitView: boolean;
  isWorkspaceMode: boolean;
  visibleTerminalIds: string[];
  resolvedActiveTerminalId: string;
  onActiveTerminalChange: (terminalId: string) => void;
  renderViewport: (terminalId: string, options: { autoFocus: boolean }) => ReactNode;
}

export default function TerminalViewportPane({
  isSplitView,
  isWorkspaceMode,
  visibleTerminalIds,
  resolvedActiveTerminalId,
  onActiveTerminalChange,
  renderViewport,
}: TerminalViewportPaneProps) {
  if (isSplitView && !isWorkspaceMode) {
    return (
      <div
        className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
        style={{
          gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
        }}
      >
        {visibleTerminalIds.map((terminalId) => (
          <div
            key={terminalId}
            className={`min-h-0 min-w-0 border-l first:border-l-0 ${
              terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
            }`}
            onMouseDown={() => {
              if (terminalId !== resolvedActiveTerminalId) {
                onActiveTerminalChange(terminalId);
              }
            }}
          >
            <div className="h-full p-1">
              {renderViewport(terminalId, { autoFocus: terminalId === resolvedActiveTerminalId })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("h-full", isWorkspaceMode ? "" : "p-1")}>
      {renderViewport(resolvedActiveTerminalId, { autoFocus: true })}
    </div>
  );
}
