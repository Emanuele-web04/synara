// FILE: EnvironmentSubagentsSection.logic.ts
// Purpose: Derives the Environment panel's subagent roster: every subagent the thread
//          (or, from a subagent thread, its parent) has spawned, not only the live-turn
//          set the composer strip shows. Live rows lead in spawn order; settled rows follow,
//          most recently settled first. Rows reuse the strip's identity/status and add the
//          Claude task usage (tokens, tool uses, duration, last tool, result summary) that
//          task.* activities carry, joined by the Task tool_use_id.
// Layer: Environment panel logic
// Exports: deriveEnvironmentSubagentRoster, environmentSubagentElapsedMs,
//          formatEnvironmentSubagentMeta, and the roster types

import type { OrchestrationThreadActivity, ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";

import { formatContextWindowTokens } from "~/lib/contextWindow";

import type { WorkLogEntry } from "../../../session-logic";
import {
  collectSubagentStripItems,
  type ComposerSubagentStripItem,
} from "../ComposerSubagentStrip.logic";
import {
  collectTaskSnapshots,
  type TaskSnapshot,
  workflowElapsedMs,
} from "../WorkflowRunCard.logic";

export interface EnvironmentSubagentRosterItem extends ComposerSubagentStripItem {
  startedAt: string | null;
  settledAt: string | null;
  totalTokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  lastToolName: string | null;
  summary: string | null;
}

export interface EnvironmentSubagentRoster {
  active: EnvironmentSubagentRosterItem[];
  previous: EnvironmentSubagentRosterItem[];
}

export const EMPTY_ENVIRONMENT_SUBAGENT_ROSTER: EnvironmentSubagentRoster = {
  active: [],
  previous: [],
};

const NO_BACKGROUNDED_THREAD_IDS: ReadonlySet<string> = new Set();

function isLiveRosterItem(item: Pick<ComposerSubagentStripItem, "statusKind">): boolean {
  return item.statusKind === "running" || item.statusKind === "queued";
}

function compareIsoAscending(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

export function deriveEnvironmentSubagentRoster(input: {
  workEntries: ReadonlyArray<WorkLogEntry>;
  // Activities of the thread that owns the Task tool calls (the strip source thread).
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  backgroundedProviderThreadIds?: ReadonlySet<string>;
  viewedThreadId?: ThreadId | null;
}): EnvironmentSubagentRoster {
  // Row keys are the subagent's provider thread id (see collectSubagentStripItems);
  // the first entry that names one is the best spawn time when no task.started exists.
  const firstSeenAtByKey = new Map<string, string>();
  for (const entry of input.workEntries) {
    for (const subagent of entry.subagents ?? []) {
      if (!firstSeenAtByKey.has(subagent.threadId)) {
        firstSeenAtByKey.set(subagent.threadId, entry.createdAt);
      }
    }
  }
  if (firstSeenAtByKey.size === 0) {
    return EMPTY_ENVIRONMENT_SUBAGENT_ROSTER;
  }

  const taskByToolUseId = new Map<string, TaskSnapshot>();
  for (const snapshot of collectTaskSnapshots(input.activities).values()) {
    if (snapshot.toolUseId) {
      taskByToolUseId.set(snapshot.toolUseId, snapshot);
    }
  }

  const items = collectSubagentStripItems(
    input.workEntries,
    input.backgroundedProviderThreadIds ?? NO_BACKGROUNDED_THREAD_IDS,
    input.viewedThreadId ?? null,
  ).map((item): EnvironmentSubagentRosterItem => {
    const task = taskByToolUseId.get(item.providerThreadId);
    // Items are freshly built per call, so extend them in place.
    return Object.assign(item, {
      startedAt: task?.startedAt ?? firstSeenAtByKey.get(item.key) ?? null,
      // The strip status (child thread session) is authoritative; a reopened task can
      // still carry an earlier settle time, so only settled rows report one.
      settledAt: isLiveRosterItem(item) ? null : (task?.settledAt ?? null),
      totalTokens: task?.totalTokens ?? null,
      toolUses: task?.toolUses ?? null,
      durationMs: task?.durationMs ?? null,
      lastToolName: task?.lastToolName ?? null,
      summary: task?.summary ?? null,
    });
  });

  const active = items
    .filter(isLiveRosterItem)
    .toSorted((left, right) => compareIsoAscending(left.startedAt, right.startedAt));
  const previous = items
    .filter((item) => !isLiveRosterItem(item))
    .toSorted((left, right) =>
      compareIsoAscending(right.settledAt ?? right.startedAt, left.settledAt ?? left.startedAt),
    );
  return { active, previous };
}

// Live rows tick from their spawn time; settled rows prefer the provider-reported
// duration and fall back to the spawn→settle wall clock.
export function environmentSubagentElapsedMs(
  item: Pick<
    EnvironmentSubagentRosterItem,
    "durationMs" | "settledAt" | "startedAt" | "statusKind"
  >,
  nowMs: number,
): number | null {
  if (item.statusKind === "queued") {
    return null;
  }
  if (!item.startedAt) {
    return item.durationMs;
  }
  const elapsedMs = workflowElapsedMs(
    {
      durationMs: item.durationMs,
      statusKind: item.statusKind ?? "completed",
      startedAt: item.startedAt,
    },
    nowMs,
  );
  if (elapsedMs !== null) {
    return elapsedMs;
  }
  const startedAtMs = Date.parse(item.startedAt);
  const settledAtMs = item.settledAt ? Date.parse(item.settledAt) : Number.NaN;
  return Number.isNaN(startedAtMs) || Number.isNaN(settledAtMs)
    ? null
    : Math.max(0, settledAtMs - startedAtMs);
}

// Secondary line after the status word. A failure shows its reason; a live row shows
// what it is doing now (last tool, tokens so far); a settled row shows its totals.
export function formatEnvironmentSubagentMeta(
  item: Pick<
    EnvironmentSubagentRosterItem,
    | "isActive"
    | "isBackground"
    | "lastToolName"
    | "statusKind"
    | "summary"
    | "toolUses"
    | "totalTokens"
  >,
  includeFailureSummary = true,
): string | null {
  if (includeFailureSummary && item.statusKind === "failed" && item.summary) {
    return item.summary;
  }
  const parts = [
    item.isActive && item.isBackground ? "background" : null,
    item.isActive ? item.lastToolName : null,
    item.totalTokens !== null ? `${formatContextWindowTokens(item.totalTokens)} tokens` : null,
    !item.isActive && item.toolUses !== null
      ? `${item.toolUses} ${pluralize(item.toolUses, "tool call")}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
