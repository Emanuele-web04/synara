// FILE: queuedComposerPause.ts
// Purpose: Decide whether a thread's composer queue is paused because the turn
//          before it was stopped by the user, failed, or hit a usage limit.
// Layer: Web queue policy (pure)
// Exports: deriveQueuedComposerPause, QueuedComposerPause, QueuedComposerPauseReason
//
// A stop is recorded explicitly (`queueStoppedTurnId`, set by the Stop action)
// because providers can settle a stopped turn as "completed", and the server can
// promote a turn it queued itself right after the stop. It holds until Resume, a
// message sent by hand, or an empty queue clears it. Failures and usage limits are
// read from the latest turn, so a newer turn that ends normally supersedes them;
// Resume acknowledges them through `queueResumedTurnId`. Both markers live in the
// persisted composer draft, so a pause survives reload.

import type { OrchestrationThreadActivity } from "@synara/contracts";

import type { Thread } from "../types";

export type QueuedComposerPauseReason = "stopped" | "error" | "usage-limit";

export interface QueuedComposerPause {
  readonly reason: QueuedComposerPauseReason;
  /** The thread's latest turn while paused; Resume acknowledges this id. */
  readonly turnId: string;
}

const USAGE_LIMIT_ERROR_PATTERN = /\b(?:usage|rate)[ _-]limit/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function turnHitUsageLimit(
  latestTurn: NonNullable<Thread["latestTurn"]>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  threadError: string | null | undefined,
): boolean {
  // The thread error can outlive its turn, so only trust it for a failed turn.
  if (latestTurn.state === "error" && threadError && USAGE_LIMIT_ERROR_PATTERN.test(threadError)) {
    return true;
  }
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    if (activity.turnId !== latestTurn.turnId && activity.createdAt < latestTurn.requestedAt) {
      // Activities are chronological; nothing older can belong to this turn.
      break;
    }
    if (activity.kind !== "account.rate-limited") continue;
    if (asRecord(activity.payload)?.status === "rejected") {
      return true;
    }
  }
  return false;
}

export function deriveQueuedComposerPause(input: {
  latestTurn: Thread["latestTurn"] | null | undefined;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  threadError: string | null | undefined;
  queuedTurnCount: number;
  stoppedTurnId: string | null | undefined;
  resumedTurnId: string | null | undefined;
}): QueuedComposerPause | null {
  const { latestTurn } = input;
  // A live turn already holds the queue; the notice appears once it settles.
  if (input.queuedTurnCount === 0 || !latestTurn || latestTurn.state === "running") {
    return null;
  }
  const acknowledged = input.resumedTurnId === latestTurn.turnId;
  if (!acknowledged && turnHitUsageLimit(latestTurn, input.activities, input.threadError)) {
    return { reason: "usage-limit", turnId: latestTurn.turnId };
  }
  // The stop holds even if the server then promotes a turn it had queued itself.
  if (input.stoppedTurnId) {
    return { reason: "stopped", turnId: latestTurn.turnId };
  }
  if (!acknowledged && latestTurn.state === "error") {
    return { reason: "error", turnId: latestTurn.turnId };
  }
  return null;
}
