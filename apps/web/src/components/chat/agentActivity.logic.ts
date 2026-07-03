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

export function isReasoningUpdateWorkEntry(entry: WorkLogEntry): boolean {
  const heading = normalizeWorkText(entry.toolTitle ?? entry.label);
  return heading === "reasoning" || heading === "reasoning update";
}

export function isAgentActivityWorkEntry(entry: WorkLogEntry): boolean {
  return entry.itemType === "collab_agent_tool_call" || isReasoningUpdateWorkEntry(entry);
}

export function formatAgentActivityEntryTitle(entry: WorkLogEntry): string {
  if (isReasoningUpdateWorkEntry(entry)) {
    return "Reasoning";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle ?? entry.label).trim();
  if (!heading) {
    return entry.itemType === "collab_agent_tool_call" ? "Agent task" : "Activity";
  }
  return capitalizePhrase(heading);
}

export function formatAgentActivityEntryPreview(entry: WorkLogEntry): string | null {
  if (isReasoningUpdateWorkEntry(entry)) {
    return cleanReasoningProgressText(entry.preview ?? entry.detail ?? entry.label);
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
  if (isReasoningUpdateWorkEntry(entry)) {
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
  const collabGroupByKey = new Map<
    string,
    { id: string; timelineIndex: number; primaryEntry: WorkLogEntry; entries: WorkLogEntry[] }
  >();
  const multiSubagentIdentities = collectMultiSubagentIdentities(entries);
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
      label: "Reasoning",
      toolTitle: "Reasoning",
      tone: "thinking",
      ...(displayPreview ? { preview: displayPreview, detail: displayPreview } : {}),
    };

    timelineWorkEntries.push(displayEntry);
    detailById.set(groupId, buildAgentActivityDetail(groupId, displayEntry, groupEntries));
  };

  for (const entry of entries) {
    if (isReasoningUpdateWorkEntry(entry)) {
      pendingReasoningEntries.push(entry);
      continue;
    }

    flushReasoningEntries();

    if (entry.itemType === "collab_agent_tool_call") {
      if (isRedundantSingleSubagentLaunch(entry, multiSubagentIdentities)) {
        continue;
      }

      const groupKeys = collabAgentActivityGroupKeys(entry);
      const existingGroup = groupKeys.map((key) => collabGroupByKey.get(key)).find(Boolean);
      if (existingGroup) {
        existingGroup.entries.push(entry);
        timelineWorkEntries[existingGroup.timelineIndex] = buildGroupedAgentActivityEntry(
          existingGroup.id,
          existingGroup.primaryEntry,
          existingGroup.entries,
        );
        for (const key of groupKeys) {
          collabGroupByKey.set(key, existingGroup);
        }
        detailById.set(
          existingGroup.id,
          buildAgentActivityDetail(
            existingGroup.id,
            existingGroup.primaryEntry,
            existingGroup.entries,
          ),
        );
        continue;
      }

      const timelineIndex = timelineWorkEntries.length;
      timelineWorkEntries.push(entry);
      detailById.set(entry.id, buildAgentActivityDetail(entry.id, entry, [entry]));
      if (groupKeys.length > 0) {
        const group = {
          id: entry.id,
          timelineIndex,
          primaryEntry: entry,
          entries: [entry],
        };
        for (const key of groupKeys) {
          collabGroupByKey.set(key, group);
        }
      }
      continue;
    }

    timelineWorkEntries.push(entry);
    if (isAgentActivityWorkEntry(entry)) {
      detailById.set(entry.id, buildAgentActivityDetail(entry.id, entry, [entry]));
    }
  }

  flushReasoningEntries();
  return { timelineWorkEntries, detailById };
}

function buildGroupedAgentActivityEntry(
  id: string,
  primaryEntry: WorkLogEntry,
  entries: ReadonlyArray<WorkLogEntry>,
): WorkLogEntry {
  const latest = entries[entries.length - 1] ?? primaryEntry;
  const prompt = findFirstCollabPrompt(entries);
  const result = findLatestCollabResult(entries);
  const subagents = mergeCollabSubagents(entries);
  return {
    ...primaryEntry,
    ...latest,
    id,
    createdAt: latest.createdAt,
    label: primaryEntry.label,
    ...(primaryEntry.toolTitle ? { toolTitle: primaryEntry.toolTitle } : {}),
    ...(prompt || primaryEntry.subagentAction || latest.subagentAction
      ? {
          subagentAction: {
            ...(primaryEntry.subagentAction ?? latest.subagentAction ?? {
              tool: "spawnAgent",
              status: latest.subagentAction?.status ?? "completed",
              summaryText: "Agent activity",
            }),
            ...(prompt ? { prompt } : {}),
          },
        }
      : {}),
    ...(result ? { detail: result } : {}),
    ...(subagents.length > 0 ? { subagents } : {}),
  };
}

function collabAgentActivityGroupKeys(entry: WorkLogEntry): string[] {
  const keys = new Set<string>();
  const toolCallId = normalizeGroupKey(entry.toolCallId);
  if (toolCallId) {
    keys.add(`tool:${toolCallId}`);
  }
  for (const subagent of entry.subagents ?? []) {
    for (const identity of subagentThreadIdentityKeys(subagent)) {
      keys.add(`agent:${identity}`);
    }
  }
  return [...keys];
}

function findCollabPrompt(entry: WorkLogEntry): string | null {
  return (
    normalizeOptionalText(entry.subagentAction?.prompt) ??
    normalizeOptionalText(entry.subagents?.find((agent) => agent.prompt)?.prompt)
  );
}

function findFirstCollabPrompt(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (const entry of entries) {
    const prompt = findCollabPrompt(entry);
    if (prompt) {
      return prompt;
    }
  }
  return null;
}

function findLatestCollabResult(entries: ReadonlyArray<WorkLogEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.itemType === "collab_agent_tool_call") {
      const result = normalizeOptionalText(entry.detail);
      if (result && result !== findCollabPrompt(entry)) {
        return result;
      }
    }
  }
  return null;
}

function mergeCollabSubagents(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry["subagents"] {
  const byThreadId = new Map<string, NonNullable<WorkLogEntry["subagents"]>[number]>();
  for (const entry of entries) {
    for (const subagent of entry.subagents ?? []) {
      byThreadId.set(subagent.threadId, { ...byThreadId.get(subagent.threadId), ...subagent });
    }
  }
  return [...byThreadId.values()];
}

function collectMultiSubagentIdentities(entries: ReadonlyArray<WorkLogEntry>): Set<string> {
  const identities = new Set<string>();
  for (const entry of entries) {
    if (entry.itemType !== "collab_agent_tool_call" || (entry.subagents?.length ?? 0) <= 1) {
      continue;
    }
    for (const subagent of entry.subagents ?? []) {
      for (const identity of subagentThreadIdentityKeys(subagent)) {
        identities.add(identity);
      }
    }
  }
  return identities;
}

function isRedundantSingleSubagentLaunch(
  entry: WorkLogEntry,
  multiSubagentIdentities: ReadonlySet<string>,
): boolean {
  const subagents = entry.subagents ?? [];
  if (subagents.length !== 1 || multiSubagentIdentities.size === 0) {
    return false;
  }
  if (
    !subagentThreadIdentityKeys(subagents[0]!).some((identity) =>
      multiSubagentIdentities.has(identity),
    )
  ) {
    return false;
  }

  const tool = normalizeGroupKey(entry.subagentAction?.tool);
  const summary = normalizeGroupKey(entry.subagentAction?.summaryText);
  const label = normalizeGroupKey(entry.label);
  const title = normalizeGroupKey(entry.toolTitle);
  const isSpawnLaunch =
    summary === "spawning 1 agent" ||
    label === "spawning 1 agent" ||
    title === "spawning 1 agent" ||
    (tool === "spawnagent" && (entry.subagentAction?.status === "inProgress" || !entry.detail));
  if (!isSpawnLaunch) {
    return false;
  }
  return true;
}

function subagentThreadIdentityKeys(
  subagent: NonNullable<WorkLogEntry["subagents"]>[number],
): string[] {
  return [
    subagent.resolvedThreadId,
    subagent.providerThreadId,
    subagent.threadId,
  ].flatMap((value) => {
    const normalized = normalizeGroupKey(value);
    return normalized ? [normalized] : [];
  });
}

function normalizeGroupKey(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
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
  const trimmed = normalizeOptionalText(value);
  if (!trimmed) {
    return null;
  }

  const withoutReasoningPrefix = trimmed
    .replace(/^reasoning\s+update\b[\s:.-]*/i, "")
    .replace(/^reasoning\b[\s:.-]*/i, "")
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
