// FILE: DiffPanel.logic.ts
// Purpose: Pure helpers for the diff panel — thread-context resolution, query-error
//   messages, and turn-summary ordering/checkpoint-range derivation.
// Layer: web (component logic, no React).
// Exports: resolveDiffPanelThread, deriveQueryErrorMessage, orderTurnDiffSummaries,
//   deriveSelectedCheckpointTurnCount, deriveConversationCheckpointTurnCount,
//   type CheckpointTurnRange
// Depends on: ChatView.logic draft-thread normalization.

import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type { DraftThreadState } from "../composerDraftStore";
import type { RepoDiffScope } from "../repoDiffScopeStore";
import { REPO_DIFF_SCOPE_LABELS } from "../repoDiffScopeStore";
import { buildFileDiffRenderKey, resolveFileDiffPath } from "../lib/diffRendering";
import { hasLiveTurnTailWork, isLatestTurnSettled } from "../session-logic";
import type { ChatMessage, Thread, TurnDiffSummary } from "../types";
import { buildLocalDraftThread } from "./ChatView.logic";

export interface CheckpointTurnRange {
  fromTurnCount: number;
  toTurnCount: number;
}

export type DiffViewKind = "repo" | "turn";
export type DiffPanelTurnScopeIntent = "all" | "last";
export type DiffPanelViewSource =
  | { kind: "repo"; scope: RepoDiffScope }
  | { kind: "turn"; turnId: TurnId | null };
export type DiffPanelScopePickerValue = RepoDiffScope | "allTurns" | "lastTurn";
export type DiffPanelPickerOption =
  | { id: "scope"; scope: RepoDiffScope }
  | { id: "allTurns" }
  | { id: "lastTurn" };

export const DIFF_PANEL_PICKER_SCOPE_OPTIONS: ReadonlyArray<RepoDiffScope> = [
  "workingTree",
  "unstaged",
  "staged",
  "branch",
];

export const DIFF_PANEL_REPO_LIVE_REFETCH_INTERVAL_MS = 10_000;

// React Query exposes errors as `unknown`; collapse to a display string.
export function deriveQueryErrorMessage(error: unknown, fallback: string): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  return error ? fallback : null;
}

type CheckpointTurnCountByTurnId = Record<string, number | undefined>;

function resolveCheckpointTurnCount(
  summary: TurnDiffSummary,
  inferredByTurnId: CheckpointTurnCountByTurnId,
): number | undefined {
  return summary.checkpointTurnCount ?? inferredByTurnId[summary.turnId];
}

// Newest checkpoint turns first, ties broken by completion time (newest first).
export function orderTurnDiffSummaries(
  summaries: readonly TurnDiffSummary[],
  inferredByTurnId: CheckpointTurnCountByTurnId,
): TurnDiffSummary[] {
  return [...summaries].toSorted((left, right) => {
    const leftTurnCount = resolveCheckpointTurnCount(left, inferredByTurnId) ?? 0;
    const rightTurnCount = resolveCheckpointTurnCount(right, inferredByTurnId) ?? 0;
    if (leftTurnCount !== rightTurnCount) {
      return rightTurnCount - leftTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  });
}

export function deriveSelectedCheckpointTurnCount(
  selectedTurn: TurnDiffSummary | undefined,
  inferredByTurnId: CheckpointTurnCountByTurnId,
): number | undefined {
  return selectedTurn ? resolveCheckpointTurnCount(selectedTurn, inferredByTurnId) : undefined;
}

export function deriveConversationCheckpointTurnCount(
  summaries: readonly TurnDiffSummary[],
  inferredByTurnId: CheckpointTurnCountByTurnId,
): number | undefined {
  const turnCounts = summaries
    .map((summary) => resolveCheckpointTurnCount(summary, inferredByTurnId))
    .filter((value): value is number => typeof value === "number");
  if (turnCounts.length === 0) {
    return undefined;
  }
  const latest = Math.max(...turnCounts);
  return latest > 0 ? latest : undefined;
}

// Reuse the chat-view draft fallback so diff surfaces keep working before the first server turn exists.
export function resolveDiffPanelThread(input: {
  threadId: ThreadId | null | undefined;
  serverThread: Thread | undefined;
  draftThread: DraftThreadState | null | undefined;
  fallbackModelSelection: ModelSelection | null | undefined;
}): Thread | undefined {
  if (input.serverThread) {
    return input.serverThread;
  }
  if (!input.threadId || !input.draftThread) {
    return undefined;
  }

  return buildLocalDraftThread(
    input.threadId,
    input.draftThread,
    input.fallbackModelSelection ?? {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    },
    null,
  );
}

export function resolveInitialDiffViewKind(selectedTurnId: TurnId | null): DiffViewKind {
  return selectedTurnId === null ? "repo" : "turn";
}

export function resolveDiffPanelRepoLiveRefresh(input: {
  latestTurn: Thread["latestTurn"];
  session: Thread["session"];
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "streaming" | "turnId">>;
  activities: Thread["activities"];
}): boolean {
  if (!input.latestTurn?.startedAt) {
    return false;
  }
  const hasLiveTail = hasLiveTurnTailWork({
    latestTurn: input.latestTurn,
    messages: input.messages,
    activities: input.activities,
    session: input.session,
  });
  return !isLatestTurnSettled(input.latestTurn, input.session) || hasLiveTail;
}

export function resolveDiffPanelRepoLiveRefetchIntervalMs(input: {
  queriesEnabled: boolean;
  liveRefreshEnabled: boolean;
  diffViewKind: DiffViewKind;
  shouldPollRepoDiff: boolean;
}): number | false {
  if (
    !input.queriesEnabled ||
    !input.liveRefreshEnabled ||
    input.diffViewKind !== "repo" ||
    !input.shouldPollRepoDiff
  ) {
    return false;
  }
  return DIFF_PANEL_REPO_LIVE_REFETCH_INTERVAL_MS;
}

export function resolveDiffPanelQueriesEnabled(input: {
  diffOpen: boolean;
  queriesEnabled?: boolean;
}): boolean {
  return input.diffOpen && (input.queriesEnabled ?? true);
}

export function resolveDiffPanelScopeCountQueriesEnabled(input: {
  queriesEnabled: boolean;
  scopePickerOpen: boolean;
}): boolean {
  return input.queriesEnabled && input.scopePickerOpen;
}

export function resolveDiffPanelGitStatusQueriesEnabled(input: {
  queriesEnabled: boolean;
  activeCwd: string | null;
  diffViewKind: DiffViewKind;
}): boolean {
  return input.queriesEnabled && input.activeCwd !== null && input.diffViewKind === "repo";
}

export function resolveDiffPanelScopeFileCounts(input: {
  viewSource: DiffPanelViewSource;
  activeScopeFileCount: number | undefined;
  scopePickerOpen: boolean;
  pickerScopeCounts: Partial<Record<RepoDiffScope, number>>;
}): Partial<Record<RepoDiffScope, number>> {
  if (input.scopePickerOpen) {
    return input.pickerScopeCounts;
  }
  if (
    input.viewSource.kind === "repo" &&
    typeof input.activeScopeFileCount === "number" &&
    input.activeScopeFileCount > 0
  ) {
    return { [input.viewSource.scope]: input.activeScopeFileCount };
  }
  return {};
}

export function resolveDiffPanelViewSource(input: {
  diffViewKind: DiffViewKind;
  repoDiffScope: RepoDiffScope;
  selectedTurnId: TurnId | null;
}): DiffPanelViewSource {
  if (input.diffViewKind === "turn") {
    return { kind: "turn", turnId: input.selectedTurnId };
  }
  return { kind: "repo", scope: input.repoDiffScope };
}

export function resolveDiffPanelPickerLabel(
  source: DiffPanelViewSource,
  turnScopeIntent?: DiffPanelTurnScopeIntent,
): string {
  if (source.kind === "turn") {
    if (source.turnId !== null) {
      return "Turn diff";
    }
    return turnScopeIntent === "last" ? "Last turn" : "All turns";
  }
  return REPO_DIFF_SCOPE_LABELS[source.scope];
}

export function resolveSelectedTurnSummary<T extends { turnId: TurnId }>(
  selectedTurnId: TurnId | null,
  orderedTurnDiffSummaries: ReadonlyArray<T>,
): T | undefined {
  if (!selectedTurnId) {
    return undefined;
  }
  return orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId);
}

export function isStaleDiffTurnSelection(
  selectedTurnId: TurnId | null,
  orderedTurnDiffSummaries: ReadonlyArray<{ turnId: TurnId }>,
): boolean {
  if (!selectedTurnId) {
    return false;
  }
  return !orderedTurnDiffSummaries.some((summary) => summary.turnId === selectedTurnId);
}

export function resolveDiffPanelScopePickerValue(input: {
  viewSource: DiffPanelViewSource;
  latestTurnId: TurnId | null;
  turnScopeIntent?: DiffPanelTurnScopeIntent;
}): DiffPanelScopePickerValue | null {
  if (input.viewSource.kind === "repo") {
    return input.viewSource.scope;
  }
  if (input.viewSource.turnId === null) {
    return input.turnScopeIntent === "last" ? "lastTurn" : "allTurns";
  }
  if (input.viewSource.turnId === input.latestTurnId) {
    return "lastTurn";
  }
  return null;
}

export function resolveConversationCacheScope(
  conversationCheckpointTurnCount: number | undefined,
): string | null {
  if (typeof conversationCheckpointTurnCount !== "number") {
    return null;
  }
  return `conversation:to-${conversationCheckpointTurnCount}`;
}

export function isDiffPanelPickerOptionSelected(
  source: DiffPanelViewSource,
  option: DiffPanelPickerOption,
  latestTurnId: TurnId | null,
  turnScopeIntent?: DiffPanelTurnScopeIntent,
): boolean {
  const activeValue = resolveDiffPanelScopePickerValue({
    viewSource: source,
    latestTurnId,
    ...(turnScopeIntent !== undefined ? { turnScopeIntent } : {}),
  });
  if (activeValue === null) {
    return false;
  }
  if (option.id === "allTurns") {
    return activeValue === "allTurns";
  }
  if (option.id === "lastTurn") {
    return activeValue === "lastTurn";
  }
  return activeValue === option.scope;
}

export function filterRenderableFilesForSearch(
  files: ReadonlyArray<FileDiffMetadata>,
  query: string,
): FileDiffMetadata[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...files];
  }
  return files.filter((fileDiff) =>
    resolveFileDiffPath(fileDiff).toLowerCase().includes(normalizedQuery),
  );
}

export function areAllRenderableFilesCollapsed(
  files: ReadonlyArray<FileDiffMetadata>,
  collapsedFiles: ReadonlySet<string>,
): boolean {
  if (files.length === 0) {
    return false;
  }
  return files.every((fileDiff) => collapsedFiles.has(buildFileDiffRenderKey(fileDiff)));
}
