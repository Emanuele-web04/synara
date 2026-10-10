// FILE: BackgroundTaskGroupRow.tsx
// Purpose: Folds three or more background task rows into one expandable line,
//          "4 background tasks · 3 finished, 1 stopped ›", so a cascade of
//          launches reads as one thing.
// Layer: Web chat presentation component
// Exports: BackgroundTaskGroupRow
// Depends on: ToolCallGroupSummaryRow (shared disclosure line and motion)

import type { ReactNode } from "react";

import { BackgroundTrayIcon } from "~/lib/icons";
import type { WorkLogEntry } from "../../session-logic";
import { summarizeBackgroundTaskGroup } from "./backgroundTaskRow.logic";
import { ToolCallGroupSummaryRow } from "./ToolCallGroupSummaryRow";

export function BackgroundTaskGroupRow(props: {
  entries: ReadonlyArray<WorkLogEntry>;
  open: boolean;
  onToggle: (open: boolean) => void;
  fontSizePx: number;
  renderEntry: (entry: WorkLogEntry) => ReactNode;
}) {
  const { entries, open, onToggle, fontSizePx, renderEntry } = props;
  const tasks = entries.flatMap((entry) => (entry.backgroundTask ? [entry.backgroundTask] : []));
  return (
    <div data-background-task-group="true">
      <ToolCallGroupSummaryRow
        label={summarizeBackgroundTaskGroup(tasks)}
        icon={BackgroundTrayIcon}
        open={open}
        onToggle={onToggle}
        fontSizePx={fontSizePx}
        renderChildren={() => <div className="space-y-0.5 pt-0.5">{entries.map(renderEntry)}</div>}
      />
    </div>
  );
}
