// FILE: DiffPanel.logic.ts
// Purpose: Pure helpers for the diff panel — thread-context resolution, query-error
//   messages, and turn-summary ordering/checkpoint-range derivation.
// Layer: web (component logic, no React).
// Exports: resolveDiffPanelThread, deriveQueryErrorMessage, orderTurnDiffSummaries,
//   deriveSelectedCheckpointTurnCount, deriveConversationCheckpointTurnCount,
//   type CheckpointTurnRange
// Depends on: ChatView.logic draft-thread normalization.

import { DEFAULT_MODEL_BY_PROVIDER, type ModelSelection, type ThreadId } from "@t3tools/contracts";

import type { DraftThreadState } from "../composerDraftStore";
import type { Thread, TurnDiffSummary } from "../types";
import { buildLocalDraftThread } from "./ChatView.logic";

export interface CheckpointTurnRange {
  fromTurnCount: number;
  toTurnCount: number;
}

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
