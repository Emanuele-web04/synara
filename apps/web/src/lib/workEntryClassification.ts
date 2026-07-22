// FILE: workEntryClassification.ts
// Purpose: Single source of truth for classifying a WorkLogEntry into an action category.
// Layer: Web UI shared logic
// Why: Both the timeline icon mapping (MessagesTimeline) and the dynamic island / sidebar
//      loader state mapping (actionStates) need the same classification. Extracting it
//      here keeps the two consumers DRY without coupling them to each other.

import { isInspectCommand } from "~/lib/toolCallLabel";
import { isFileChangeWorkLogEntry, type WorkLogEntry } from "~/workLog";

export type WorkEntryCategory = "thinking" | "reading" | "editing" | "running-command" | "error";

// Provider read tools (e.g. Claude's `Read`) arrive as generic dynamic tool calls
// without a `file-read` requestKind, so match their tool name to classify as reading.
export function isFileReadToolEntry(workEntry: Pick<WorkLogEntry, "toolName">): boolean {
  const name = (workEntry.toolName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "read" || name === "readfile" || name === "viewfile";
}

// Classify a work entry into an action category. Order matters: specific activity types
// take precedence over tone, so a failed command still shows as "running-command" (the
// activity the agent was performing) rather than a generic "error". Error tone is the
// fallback for entries that don't map to a specific activity.
//
// Inspect commands (ls/cat/grep/find/rg) are classified as "reading" — they inspect
// the filesystem without modifying it, matching the timeline icon mapping.
export function classifyWorkEntry(
  workEntry: Pick<WorkLogEntry, "requestKind" | "itemType" | "command" | "toolName" | "tone">,
): WorkEntryCategory {
  if (workEntry.requestKind === "command") {
    return workEntry.command && isInspectCommand(workEntry.command) ? "reading" : "running-command";
  }
  if (workEntry.requestKind === "file-read") return "reading";
  if (isFileChangeWorkLogEntry(workEntry)) return "editing";
  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return workEntry.command && isInspectCommand(workEntry.command) ? "reading" : "running-command";
  }
  if (isFileReadToolEntry(workEntry)) return "reading";
  if (workEntry.tone === "error") return "error";
  return "thinking";
}
