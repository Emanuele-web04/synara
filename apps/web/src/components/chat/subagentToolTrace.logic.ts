// FILE: subagentToolTrace.logic.ts
// Purpose: Derive the compact native-CLI-style tool trace shown under a subagent row
// in the parent transcript: the child thread's most recent tool calls plus an
// overflow count, live while the subagent runs and frozen once it settles.
// Layer: Chat presentation logic
// Exports: deriveSubagentToolTrace, deriveSubagentToolTraceByThreadId, and the trace types

import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";
import type { Thread } from "../../types";
import { isCodexActivityStatusWorkEntry, isReasoningUpdateWorkEntry } from "./agentActivity.logic";

export const SUBAGENT_TOOL_TRACE_MAX_ITEMS = 4;

export interface SubagentToolTrace {
  // Most recent tool-call entries, oldest first.
  entries: WorkLogEntry[];
  // Earlier tool uses hidden by the recency cap.
  overflowCount: number;
  // True while the subagent still runs; a settled trace stays frozen as-is.
  isLive: boolean;
}

// Tool uses only: reasoning traces and status-only rows are child-thread chrome,
// not tool calls, and would crowd the trace out of parity with the native CLI.
export function isSubagentTraceToolEntry(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "tool" &&
    !isReasoningUpdateWorkEntry(entry) &&
    !isCodexActivityStatusWorkEntry(entry)
  );
}

export function deriveSubagentToolTrace(
  entries: ReadonlyArray<WorkLogEntry>,
  isLive: boolean,
  maxItems: number = SUBAGENT_TOOL_TRACE_MAX_ITEMS,
): SubagentToolTrace | null {
  const toolEntries = entries.filter(isSubagentTraceToolEntry);
  if (toolEntries.length === 0) {
    return null;
  }
  const recentEntries = toolEntries.slice(-maxItems);
  return {
    entries: recentEntries,
    overflowCount: toolEntries.length - recentEntries.length,
    isLive,
  };
}

// Builds the per-subagent trace map for one transcript render pass. Keys are the
// enriched resolvedThreadId (the child thread's local id), so lookups match the
// timeline's subagent rows. Child activities come from the store; live subagents
// keep them hydrated via retained detail subscriptions, settled ones stay frozen.
export function deriveSubagentToolTraceByThreadId(input: {
  workEntries: ReadonlyArray<WorkLogEntry>;
  threads: ReadonlyArray<Thread>;
}): ReadonlyMap<string, SubagentToolTrace> {
  const traceByThreadId = new Map<string, SubagentToolTrace>();
  const threadById = new Map<string, Thread>(input.threads.map((thread) => [thread.id, thread]));

  for (const entry of input.workEntries) {
    for (const subagent of entry.subagents ?? []) {
      const threadId = subagent.resolvedThreadId;
      if (!threadId) {
        continue;
      }
      const isLive = subagent.isActive === true;
      const existing = traceByThreadId.get(threadId);
      if (existing) {
        // Later snapshots carry the freshest liveness; the entries are identical.
        if (existing.isLive !== isLive) {
          traceByThreadId.set(threadId, { ...existing, isLive });
        }
        continue;
      }
      const thread = threadById.get(threadId);
      if (!thread || thread.activities.length === 0) {
        continue;
      }
      const trace = deriveSubagentToolTrace(
        deriveWorkLogEntries(thread.activities, undefined),
        isLive,
      );
      if (trace) {
        traceByThreadId.set(threadId, trace);
      }
    }
  }

  return traceByThreadId;
}
