// FILE: ComposerSubagentStrip.logic.ts
// Purpose: Derives the subagent rows shown in the composer strip from enriched work
// log entries, mirroring the active-task-list scoping (live turn wins; a prior set
// stays visible only while some subagent is still working).
// Layer: Chat composer logic
// Exports: deriveComposerSubagentStripItems and ComposerSubagentStripItem

import { ThreadId, type TurnId } from "@synara/contracts";

import type { WorkLogEntry, WorkLogSubagent } from "../../session-logic";
import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
  type SubagentStatusKind,
} from "../../lib/subagentPresentation";

export interface ComposerSubagentStripItem {
  key: string;
  threadId: ThreadId;
  primaryLabel: string;
  fullLabel: string;
  role: string | null;
  modelLabel: string | undefined;
  statusLabel: string | undefined;
  statusKind: SubagentStatusKind | null;
  isActive: boolean;
  accentColor: string;
}

// The provider thread id is present on every snapshot of a subagent, unlike
// resolvedThreadId/agentId which can appear only once resolution catches up.
function subagentKey(subagent: WorkLogSubagent): string {
  return subagent.threadId;
}

// Later snapshots carry the freshest status, but may omit identity fields the spawn
// snapshot had; keep identity via fallback while taking the status fields verbatim.
function mergeSubagentSnapshots(previous: WorkLogSubagent, next: WorkLogSubagent): WorkLogSubagent {
  return {
    threadId: next.threadId ?? previous.threadId,
    providerThreadId: next.providerThreadId ?? previous.providerThreadId,
    resolvedThreadId: next.resolvedThreadId ?? previous.resolvedThreadId,
    agentId: next.agentId ?? previous.agentId,
    nickname: next.nickname ?? previous.nickname,
    role: next.role ?? previous.role,
    model: next.model ?? previous.model,
    prompt: next.prompt ?? previous.prompt,
    title: next.title ?? previous.title,
    latestUpdate: next.latestUpdate ?? previous.latestUpdate,
    rawStatus: next.rawStatus,
    statusLabel: next.statusLabel,
    isActive: next.isActive,
  };
}

function toStripItem(key: string, subagent: WorkLogSubagent): ComposerSubagentStripItem {
  const presentation = resolveSubagentPresentation({
    nickname: subagent.nickname,
    role: subagent.role,
    title: subagent.title,
    fallbackId: subagent.threadId,
  });
  const statusLabel =
    subagent.statusLabel ?? humanizeSubagentStatus(subagent.rawStatus, subagent.isActive);
  const statusKind = normalizeSubagentStatusKind(
    statusLabel ?? subagent.rawStatus,
    subagent.isActive,
  );

  return {
    key,
    threadId: ThreadId.makeUnsafe(subagent.resolvedThreadId ?? subagent.threadId),
    primaryLabel: presentation.nickname ?? presentation.primaryLabel,
    fullLabel: presentation.fullLabel,
    role: presentation.role,
    modelLabel: formatSubagentModelLabel(subagent.model),
    statusLabel,
    statusKind,
    isActive: statusKind === "running",
    accentColor: presentation.accentColor,
  };
}

function collectStripItems(entries: ReadonlyArray<WorkLogEntry>): ComposerSubagentStripItem[] {
  const subagentByKey = new Map<string, WorkLogSubagent>();
  for (const entry of entries) {
    for (const subagent of entry.subagents ?? []) {
      const key = subagentKey(subagent);
      const previous = subagentByKey.get(key);
      subagentByKey.set(key, previous ? mergeSubagentSnapshots(previous, subagent) : subagent);
    }
  }
  return [...subagentByKey.entries()].map(([key, subagent]) => toStripItem(key, subagent));
}

export function deriveComposerSubagentStripItems(input: {
  workEntries: ReadonlyArray<WorkLogEntry>;
  liveTurnId: TurnId | null;
}): ComposerSubagentStripItem[] {
  const entriesWithSubagents = input.workEntries.filter(
    (entry) => (entry.subagents?.length ?? 0) > 0,
  );
  if (entriesWithSubagents.length === 0) {
    return [];
  }

  const liveTurnEntries = input.liveTurnId
    ? entriesWithSubagents.filter((entry) => entry.turnId === input.liveTurnId)
    : [];
  if (liveTurnEntries.length > 0) {
    return collectStripItems(liveTurnEntries);
  }

  // No subagents spawned by the live turn: keep the latest known set visible only
  // while some subagent is still running or queued, then let the strip retire.
  const items = collectStripItems(entriesWithSubagents);
  return items.some((item) => item.statusKind === "running" || item.statusKind === "queued")
    ? items
    : [];
}
