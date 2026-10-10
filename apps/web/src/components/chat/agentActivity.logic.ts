// FILE: agentActivity.logic.ts
// Purpose: Derive compact transcript rows and full-detail models for agent activity.
// Layer: Chat presentation helpers
// Exports: agent activity detection, formatting, and timeline compaction

import { normalizeCompactToolLabel } from "../../lib/toolCallLabel";
import type { WorkLogEntry } from "../../session-logic";

export interface AgentActivityDetail {
  id: string;
  title: string;
  summary: string | null;
  primaryEntry: WorkLogEntry;
  entries: WorkLogEntry[];
}

export interface AgentActivityTimelineState {
  timelineWorkEntries: WorkLogEntry[];
  detailById: Map<string, AgentActivityDetail>;
}

const REASONING_GROUP_PREFIX = "agent-reasoning";
const SUBAGENT_PROGRESS_GROUP_PREFIX = "subagent-progress";

// A subagent's own progress reported to its launcher: its current step,
// attributed to that subagent, never the launcher's reasoning.
export function isSubagentProgressWorkEntry(
  entry: Pick<WorkLogEntry, "subagentProgress">,
): boolean {
  return entry.subagentProgress !== undefined;
}

function subagentProgressTitle(entry: Pick<WorkLogEntry, "subagentProgress">): string {
  return entry.subagentProgress?.title ?? "Subagent";
}

export function isReasoningUpdateWorkEntry(
  entry: Pick<WorkLogEntry, "label" | "toolTitle">,
): boolean {
  const heading = normalizeWorkText(entry.toolTitle ?? entry.label);
  return (
    heading === "reasoning" ||
    heading === "reasoning update" ||
    heading === "reasoning trace" ||
    heading === "reasoning summary"
  );
}

export function isCodexActivityStatusWorkEntry(entry: WorkLogEntry): boolean {
  if (isReasoningUpdateWorkEntry(entry) || entry.activityKind === "tool.summary") {
    return true;
  }
  const isStatusOnlyCommand =
    entry.itemType === "command_execution" && !entry.command && !entry.rawCommand;
  return (
    isStatusOnlyCommand || normalizeWorkText(entry.toolTitle ?? entry.label) === "command execution"
  );
}

// Generic runtime notices (unhandled SDK messages, retries) render as quiet italic
// text without a leading glyph; the tone checkmark made them read as completed work.
// Notices with their own semantic icon keep it.
export function isPlainRuntimeNoticeWorkEntry(
  entry: Pick<WorkLogEntry, "activityKind" | "nativeEventType" | "providerContextLifecycle">,
): boolean {
  return (
    entry.activityKind === "auth.status" ||
    (entry.activityKind === "runtime.warning" &&
      entry.nativeEventType !== "background_tasks_changed" &&
      entry.nativeEventType !== "monitor_event" &&
      !entry.providerContextLifecycle)
  );
}

export function isAgentActivityWorkEntry(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "collab_agent_tool_call" ||
    entry.activityKind === "tool.summary" ||
    isReasoningUpdateWorkEntry(entry) ||
    isSubagentProgressWorkEntry(entry)
  );
}

// Unmapped provider events keep their native type as the title and a safe detail as preview.
export function isUnmappedProviderEventWorkEntry(
  entry: Pick<WorkLogEntry, "activityKind">,
): boolean {
  return entry.activityKind === "provider.event.unmapped";
}

export function formatAgentActivityEntryTitle(entry: WorkLogEntry): string {
  if (isSubagentProgressWorkEntry(entry)) {
    return subagentProgressTitle(entry);
  }
  if (isReasoningUpdateWorkEntry(entry)) {
    return "Reasoning";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle ?? entry.label).trim();
  if (heading) {
    return capitalizePhrase(heading);
  }
  if (isUnmappedProviderEventWorkEntry(entry) && entry.nativeEventType) {
    // The raw native type/label is the only title the event carries; use it
    // verbatim instead of degrading to the generic "Activity" label.
    return capitalizePhrase(entry.nativeEventType);
  }
  return entry.itemType === "collab_agent_tool_call" ? "Agent task" : "Activity";
}

export function formatAgentActivityEntryPreview(entry: WorkLogEntry): string | null {
  if (isReasoningUpdateWorkEntry(entry)) {
    return cleanReasoningProgressText(entry.preview ?? entry.detail ?? entry.label);
  }
  if (isSubagentProgressWorkEntry(entry)) {
    // Progress lines are present tense ("Running …"); the step reads the same
    // once the subagent settles, so drop the tense prefix.
    return cleanReasoningProgressText(entry.preview ?? entry.detail);
  }

  if (entry.itemType === "collab_agent_tool_call") {
    return (
      normalizeOptionalText(entry.detail) ??
      normalizeOptionalText(entry.preview) ??
      normalizeOptionalText(entry.subagentAction?.prompt) ??
      normalizeOptionalText(entry.subagentAction?.summaryText)
    );
  }

  return normalizeOptionalText(entry.preview) ?? normalizeOptionalText(entry.detail);
}

export function formatAgentActivityEntrySummary(entry: WorkLogEntry): string | null {
  if (isReasoningUpdateWorkEntry(entry) || isSubagentProgressWorkEntry(entry)) {
    return formatAgentActivityEntryPreview(entry);
  }

  if (entry.itemType === "collab_agent_tool_call") {
    return (
      normalizeOptionalText(entry.subagentAction?.prompt) ??
      normalizeOptionalText(entry.subagentAction?.summaryText) ??
      normalizeOptionalText(entry.preview)
    );
  }

  return normalizeOptionalText(entry.preview);
}

export function deriveAgentActivityTimelineState(
  entries: ReadonlyArray<WorkLogEntry>,
): AgentActivityTimelineState {
  const timelineWorkEntries: WorkLogEntry[] = [];
  const detailById = new Map<string, AgentActivityDetail>();
  let pendingReasoningEntries: WorkLogEntry[] = [];

  const flushReasoningEntries = () => {
    if (pendingReasoningEntries.length === 0) {
      return;
    }

    const groupEntries = pendingReasoningEntries;
    pendingReasoningEntries = [];
    const first = groupEntries[0]!;
    const latest = groupEntries[groupEntries.length - 1]!;
    const groupId = `${REASONING_GROUP_PREFIX}:${first.id}`;
    const latestPreview = findLatestPreview(groupEntries);
    const updateCount = groupEntries.length;
    const displayPreview =
      updateCount > 1
        ? latestPreview
          ? `${updateCount} updates - ${latestPreview}`
          : `${updateCount} updates`
        : latestPreview;
    const displayEntry: WorkLogEntry = {
      ...latest,
      id: groupId,
      createdAt: first.createdAt,
      label: "Reasoning trace",
      toolTitle: "Reasoning trace",
      tone: "tool",
      ...(displayPreview ? { preview: displayPreview, detail: displayPreview } : {}),
    };

    timelineWorkEntries.push(displayEntry);
    detailById.set(groupId, buildAgentActivityDetail(groupId, displayEntry, groupEntries));
  };

  // One row per subagent invocation per turn, anchored at its first update:
  // parallel subagents interleave their updates, and a turn boundary or a
  // different subagent always starts a new group.
  const subagentProgressGroups = new Map<string, { index: number; entries: WorkLogEntry[] }>();
  const upsertSubagentProgressGroup = (entry: WorkLogEntry) => {
    const key = `${entry.turnId ?? "no-turn"}\u001f${entry.subagentProgress!.toolUseId}\u001f${entry.subagentProgress!.invocationId ?? "legacy"}`;
    const group = subagentProgressGroups.get(key);
    const groupEntries = group ? [...group.entries, entry] : [entry];
    const first = groupEntries[0]!;
    const groupId = `${SUBAGENT_PROGRESS_GROUP_PREFIX}:${first.id}`;
    const latestStep = findLatestPreview(groupEntries);
    // A subagent that was stopped or failed says so; its last step is not done.
    const outcome = entry.subagentProgress?.outcome;
    const outcomeLabel =
      outcome === "stopped" ? "Stopped" : outcome === "failed" ? "Failed" : undefined;
    const latestPreview =
      outcomeLabel !== undefined
        ? latestStep
          ? `${outcomeLabel} - ${latestStep}`
          : outcomeLabel
        : latestStep;
    const displayPreview =
      groupEntries.length > 1
        ? latestPreview
          ? `${groupEntries.length} updates - ${latestPreview}`
          : `${groupEntries.length} updates`
        : latestPreview;
    const title = subagentProgressTitle(entry);
    const displayEntry: WorkLogEntry = {
      ...entry,
      id: groupId,
      createdAt: first.createdAt,
      ...(first.sequence !== undefined ? { sequence: first.sequence } : {}),
      label: title,
      toolTitle: title,
      // Not a tool call: keep it out of "Ran N tool calls" summaries.
      tone: outcome === "failed" ? "error" : "info",
      ...(displayPreview ? { preview: displayPreview, detail: displayPreview } : {}),
    };
    if (group) {
      timelineWorkEntries[group.index] = displayEntry;
      group.entries = groupEntries;
    } else {
      subagentProgressGroups.set(key, { index: timelineWorkEntries.length, entries: groupEntries });
      timelineWorkEntries.push(displayEntry);
    }
    detailById.set(groupId, buildAgentActivityDetail(groupId, displayEntry, groupEntries));
  };

  for (const entry of entries) {
    if (isSubagentProgressWorkEntry(entry)) {
      flushReasoningEntries();
      upsertSubagentProgressGroup(entry);
      continue;
    }
    // Legacy providers emit free-standing reasoning updates with no item id;
    // keep compacting those. Canonical Codex reasoning carries toolCallId, so
    // each completed provider item remains its own visible row. A group never
    // spans two turns.
    if (isReasoningUpdateWorkEntry(entry) && !entry.toolCallId) {
      const previous = pendingReasoningEntries.at(-1);
      if (previous && (previous.turnId ?? null) !== (entry.turnId ?? null)) {
        flushReasoningEntries();
      }
      pendingReasoningEntries.push(entry);
      continue;
    }

    flushReasoningEntries();
    const reasoningPreview = isReasoningUpdateWorkEntry(entry)
      ? formatAgentActivityEntryPreview(entry)
      : null;
    // Old Synara builds persisted a literal placeholder for every empty Codex
    // reasoning lifecycle. Match Codex history semantics and hide those rows.
    if (isReasoningUpdateWorkEntry(entry) && !reasoningPreview) {
      continue;
    }
    const displayEntry = reasoningPreview
      ? {
          ...entry,
          label: "Reasoning trace",
          toolTitle: "Reasoning trace",
          preview: reasoningPreview,
          tone: "tool" as const,
        }
      : entry;
    timelineWorkEntries.push(displayEntry);
    if (isAgentActivityWorkEntry(entry)) {
      detailById.set(entry.id, buildAgentActivityDetail(entry.id, displayEntry, [entry]));
    }
  }

  flushReasoningEntries();
  return { timelineWorkEntries, detailById };
}

function buildAgentActivityDetail(
  id: string,
  primaryEntry: WorkLogEntry,
  entries: ReadonlyArray<WorkLogEntry>,
): AgentActivityDetail {
  const title = formatAgentActivityEntryTitle(primaryEntry);
  return {
    id,
    title,
    summary: findLatestSummary(entries),
    primaryEntry,
    entries: [...entries],
  };
}

function findLatestPreview(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const preview = formatAgentActivityEntryPreview(entries[index]!);
    if (preview) {
      return preview;
    }
  }
  return null;
}

function findLatestSummary(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const summary = formatAgentActivityEntrySummary(entries[index]!);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function cleanReasoningProgressText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  // Codex summaries are Markdown blocks such as
  // `**Planning the implementation**\n\n<!-- -->`. Its compact UI label is the
  // last readable line, with comments and lightweight Markdown removed.
  const readableLines = value
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("<!--"));
  const latestLine = readableLines.at(-1);
  if (!latestLine) {
    return null;
  }
  const trimmed = latestLine
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1")
    .replace(/^__(.+)__$/u, "$1")
    .replace(/^`(.+)`$/u, "$1")
    .trim();

  const withoutReasoningPrefix = trimmed
    .replace(/^reasoning(?:\s+(?:update|trace|summary))?\b[\s:.-]*/i, "")
    .trim();
  const withoutRunningPrefix = withoutReasoningPrefix.replace(/^running\b[\s:.-]*/i, "").trim();
  return withoutRunningPrefix || withoutReasoningPrefix || null;
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkText(value: string): string {
  return normalizeCompactToolLabel(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}
