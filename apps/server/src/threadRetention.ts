// FILE: threadRetention.ts
// Purpose: Runs the server-side cleanup loop for inactive orchestration threads.
// Layer: Server maintenance
// Exports: retention constants, stale-thread selection, and scoped job startup.

import { CommandId, type OrchestrationReadModel, type ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";

export const THREAD_RETENTION_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
export const THREAD_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const THREAD_RETENTION_STARTUP_DELAY_MS = 5_000;

type RetentionThread = OrchestrationReadModel["threads"][number];

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getThreadLastActivityMs(thread: RetentionThread): number | null {
  return (
    parseIsoMs(thread.latestUserMessageAt) ??
    parseIsoMs(thread.updatedAt) ??
    parseIsoMs(thread.createdAt)
  );
}

function isThreadBusy(thread: RetentionThread): boolean {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return true;
  }
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return true;
  }
  if (thread.latestTurn?.state === "running") {
    return true;
  }
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
    return true;
  }
  return false;
}

// Picks the same threads manual deletion can delete, while protecting active work.
export function getInactiveThreadIdsForRetention(
  readModel: OrchestrationReadModel,
  nowMs = Date.now(),
): ThreadId[] {
  const cutoffMs = nowMs - THREAD_RETENTION_UNUSED_MS;
  const inactiveThreadIds: ThreadId[] = [];

  for (const thread of readModel.threads) {
    if (thread.deletedAt !== null) continue;
    if (isThreadBusy(thread)) continue;
    const lastActivityMs = getThreadLastActivityMs(thread);
    if (lastActivityMs === null || lastActivityMs > cutoffMs) continue;
    inactiveThreadIds.push(thread.id);
  }

  return inactiveThreadIds;
}

export const runThreadRetentionSweep = Effect.fn("runThreadRetentionSweep")(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  const readModel = yield* orchestrationEngine.getReadModel();
  const inactiveThreadIds = getInactiveThreadIdsForRetention(readModel);
  if (inactiveThreadIds.length === 0) {
    return;
  }

  yield* Effect.logInfo("deleting inactive orchestration threads").pipe(
    Effect.annotateLogs({ count: inactiveThreadIds.length }),
  );

  yield* Effect.forEach(
    inactiveThreadIds,
    (threadId) =>
      orchestrationEngine
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.makeUnsafe(`thread-retention:${randomUUID()}`),
          threadId,
        })
        .pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("failed to delete inactive thread during retention sweep").pipe(
              Effect.annotateLogs({
                threadId,
                error: String(error),
              }),
            ),
          ),
        ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);
});

export const startThreadRetentionJob = Effect.fn("startThreadRetentionJob")(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  yield* Effect.forever(
    Effect.sleep(THREAD_RETENTION_SWEEP_INTERVAL_MS).pipe(
      Effect.flatMap(() => runThreadRetentionSweep(orchestrationEngine)),
    ),
    { disableYield: true },
  ).pipe(Effect.forkScoped);

  yield* Effect.sleep(THREAD_RETENTION_STARTUP_DELAY_MS).pipe(
    Effect.flatMap(() => runThreadRetentionSweep(orchestrationEngine)),
    Effect.forkScoped,
  );
});
