// FILE: TimelineWorkEntryRow.subagentProgress.test.tsx
// Purpose: A subagent's progress row never reads as a finished step: it keeps
// the agent glyph (or a warning when the subagent failed), never the success check.
// Layer: Chat transcript UI regression test

import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../workLog";
import { workEntryLeftIcon } from "./TimelineWorkEntryRow";
import { CheckIcon, CircleAlertIcon } from "~/lib/icons";

function progressEntry(outcome?: "completed" | "failed" | "stopped"): WorkLogEntry {
  return {
    id: "subagent-progress:p-1",
    createdAt: new Date(0).toISOString(),
    label: "Waiter A",
    toolTitle: "Waiter A",
    tone: outcome === "failed" ? "error" : "info",
    activityKind: "task.progress",
    subagentProgress: {
      toolUseId: "toolu_waiter_a",
      title: "Waiter A",
      ...(outcome ? { outcome } : {}),
    },
  };
}

describe("TimelineWorkEntryRow subagent progress", () => {
  it("never shows the success check for a subagent's progress", () => {
    expect(workEntryLeftIcon(progressEntry())).not.toBe(CheckIcon);
    expect(workEntryLeftIcon(progressEntry("stopped"))).not.toBe(CheckIcon);
    expect(workEntryLeftIcon(progressEntry("completed"))).not.toBe(CheckIcon);
  });

  it("warns when the subagent failed", () => {
    expect(workEntryLeftIcon(progressEntry("failed"))).toBe(CircleAlertIcon);
  });
});
