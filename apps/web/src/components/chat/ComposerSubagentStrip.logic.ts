// FILE: ComposerSubagentStrip.logic.ts
// Purpose: Derives the subagent rows shown in the composer strip from enriched work
// log entries, mirroring the active-task-list scoping (live turn wins; a prior set
// stays visible only while some subagent is still working).
// Layer: Chat composer logic
// Exports: deriveComposerSubagentStripItems and the strip row types

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
  kind: "subagent";
  key: string;
  threadId: ThreadId;
  // Task tool_use_id: the handle for per-run task control (background/stop).
  providerThreadId: string;
  primaryLabel: string;
  fullLabel: string;
  role: string | null;
  modelLabel: string | undefined;
  statusLabel: string | undefined;
  statusKind: SubagentStatusKind | null;
  isActive: boolean;
  // True when this row is the thread currently open in the chat pane (viewing a
  // sibling from inside a subagent thread).
  isViewed: boolean;
  isBackground: boolean;
  accentColor: string;
}

// Leading "back to the main thread" row shown while a subagent thread is open.
export interface ComposerSubagentStripParentItem {
  kind: "parent";
  key: string;
  threadId: ThreadId;
  label: string;
}

export type ComposerSubagentStripRow = ComposerSubagentStripItem | ComposerSubagentStripParentItem;

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
    effort: next.effort ?? previous.effort,
    background: next.background ?? previous.background,
    prompt: next.prompt ?? previous.prompt,
    title: next.title ?? previous.title,
    latestUpdate: next.latestUpdate ?? previous.latestUpdate,
    rawStatus: next.rawStatus,
    statusLabel: next.statusLabel,
    isActive: next.isActive,
  };
}

function toStripItem(
  key: string,
  subagent: WorkLogSubagent,
  backgroundedThreadIds: ReadonlySet<string>,
  viewedThreadId: ThreadId | null,
): ComposerSubagentStripItem {
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
  const modelLabel = formatSubagentModelLabel(subagent.model);
  const threadId = ThreadId.makeUnsafe(subagent.resolvedThreadId ?? subagent.threadId);

  return {
    kind: "subagent",
    key,
    threadId,
    providerThreadId: subagent.providerThreadId ?? subagent.threadId,
    primaryLabel: presentation.nickname ?? presentation.primaryLabel,
    fullLabel: presentation.fullLabel,
    role: presentation.role,
    modelLabel:
      modelLabel && subagent.effort
        ? `${modelLabel} · ${subagent.effort}`
        : (modelLabel ?? subagent.effort),
    statusLabel,
    statusKind,
    isActive: statusKind === "running",
    isViewed: viewedThreadId !== null && threadId === viewedThreadId,
    // Confirmed patches key by the Task tool_use_id — the same handle the
    // background command dispatches with — which can differ from the row key.
    isBackground:
      subagent.background === true ||
      backgroundedThreadIds.has(subagent.providerThreadId ?? subagent.threadId),
    accentColor: presentation.accentColor,
  };
}

function collectStripItems(
  entries: ReadonlyArray<WorkLogEntry>,
  backgroundedThreadIds: ReadonlySet<string>,
  viewedThreadId: ThreadId | null,
): ComposerSubagentStripItem[] {
  const subagentByKey = new Map<string, WorkLogSubagent>();
  for (const entry of entries) {
    for (const subagent of entry.subagents ?? []) {
      const key = subagentKey(subagent);
      const previous = subagentByKey.get(key);
      subagentByKey.set(key, previous ? mergeSubagentSnapshots(previous, subagent) : subagent);
    }
  }
  return [...subagentByKey.entries()].map(([key, subagent]) =>
    toStripItem(key, subagent, backgroundedThreadIds, viewedThreadId),
  );
}

// Rows the header stop-all control targets: running subagent rows only.
export function collectRunningSubagentStripItems(
  rows: ReadonlyArray<ComposerSubagentStripRow>,
): ComposerSubagentStripItem[] {
  return rows.filter(
    (row): row is ComposerSubagentStripItem => row.kind === "subagent" && row.isActive,
  );
}

// Rows the per-row background action and Ctrl+B target: running rows not yet
// backgrounded by either the spawn hint or a confirmed task_updated patch.
export function collectForegroundRunningSubagentStripItems(
  rows: ReadonlyArray<ComposerSubagentStripRow>,
): ComposerSubagentStripItem[] {
  return collectRunningSubagentStripItems(rows).filter((row) => !row.isBackground);
}

const NO_BACKGROUNDED_THREAD_IDS: ReadonlySet<string> = new Set();

function withParentRow(
  items: ComposerSubagentStripItem[],
  parentRow: { threadId: ThreadId; label: string | null } | null | undefined,
): ComposerSubagentStripRow[] {
  if (items.length === 0 || !parentRow) {
    return items;
  }
  return [
    {
      kind: "parent",
      key: `parent:${parentRow.threadId}`,
      threadId: parentRow.threadId,
      label: parentRow.label ?? "Main thread",
    },
    ...items,
  ];
}

export function deriveComposerSubagentStripItems(input: {
  workEntries: ReadonlyArray<WorkLogEntry>;
  liveTurnId: TurnId | null;
  // Task tool_use_ids the provider confirmed as backgrounded (task_updated patches).
  backgroundedProviderThreadIds?: ReadonlySet<string>;
  // The open thread when it is one of the subagents (marks its row as viewed).
  viewedThreadId?: ThreadId | null;
  // Present while a subagent thread is open: prepends a row back to the parent.
  parentRow?: { threadId: ThreadId; label: string | null } | null;
}): ComposerSubagentStripRow[] {
  const entriesWithSubagents = input.workEntries.filter(
    (entry) => (entry.subagents?.length ?? 0) > 0,
  );
  if (entriesWithSubagents.length === 0) {
    return [];
  }

  const backgroundedThreadIds = input.backgroundedProviderThreadIds ?? NO_BACKGROUNDED_THREAD_IDS;
  const viewedThreadId = input.viewedThreadId ?? null;
  const liveTurnEntries = input.liveTurnId
    ? entriesWithSubagents.filter((entry) => entry.turnId === input.liveTurnId)
    : [];
  if (liveTurnEntries.length > 0) {
    return withParentRow(
      collectStripItems(liveTurnEntries, backgroundedThreadIds, viewedThreadId),
      input.parentRow,
    );
  }

  // No subagents spawned by the live turn: keep the latest known set visible only
  // while some subagent is still running or queued, then let the strip retire.
  const items = collectStripItems(entriesWithSubagents, backgroundedThreadIds, viewedThreadId);
  return items.some((item) => item.statusKind === "running" || item.statusKind === "queued")
    ? withParentRow(items, input.parentRow)
    : [];
}
