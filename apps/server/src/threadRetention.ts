// FILE: threadRetention.ts
// Purpose: Runs the server-side cleanup loop for inactive orchestration threads.
// Layer: Server maintenance
// Exports: retention constants, stale-thread selection, and scoped job startup.

import { CommandId, type OrchestrationReadModel, type ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { randomUUID } from "node:crypto";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";

export const THREAD_RETENTION_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
export const THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS = 5 * 60 * 1000;
export const THREAD_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const THREAD_RETENTION_BATCH_SIZE = 25;
const THREAD_RETENTION_BATCH_PAUSE_MS = 50;
const RETENTION_COMPACT_FREE_PAGE_THRESHOLD = 8192;

type RetentionThread = OrchestrationReadModel["threads"][number];

type RetentionMaintenanceState = "started" | "progress" | "compacting" | "completed" | "failed";

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

function chunkThreadIds(
  threadIds: Iterable<ThreadId>,
  size = THREAD_RETENTION_BATCH_SIZE,
): ThreadId[][] {
  const chunks: ThreadId[][] = [];
  let chunk: ThreadId[] = [];
  for (const threadId of threadIds) {
    chunk.push(threadId);
    if (chunk.length < size) continue;
    chunks.push(chunk);
    chunk = [];
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

const pauseBetweenRetentionBatches = Effect.sleep(THREAD_RETENTION_BATCH_PAUSE_MS);

const publishRetentionMaintenance = Effect.fn("publishRetentionMaintenance")(function* (
  state: RetentionMaintenanceState,
  details: {
    readonly deletedCount?: number;
    readonly purgedCount?: number;
    readonly totalCount?: number;
    readonly freePageCount?: number;
    readonly error?: string;
  } = {},
) {
  const lifecycleEvents = yield* ServerLifecycleEvents;
  yield* lifecycleEvents
    .publish({
      type: "maintenance",
      payload: {
        task: "thread-retention",
        state,
        at: new Date().toISOString(),
        ...details,
      },
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logDebug("failed to publish thread retention maintenance event").pipe(
          Effect.annotateLogs({ state, error: String(error) }),
        ),
      ),
    );
});

export const purgeThreadDatabaseRows = Effect.fn("purgeThreadDatabaseRows")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;

  // Retention is destructive: remove replay events plus derived rows so old
  // threads do not keep bloating production SQLite forever.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM projection_pending_approvals
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM checkpoint_diff_blobs
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread'
          AND aggregate_id = ${threadId}
      `;
      yield* sql`
        DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
    }),
  );
});

const compactDatabaseAfterRetention = Effect.fn("compactDatabaseAfterRetention")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const freePageRows = yield* sql<{ readonly freelist_count: number }>`
    PRAGMA freelist_count
  `;
  const freePageCount = freePageRows[0]?.freelist_count ?? 0;
  if (freePageCount < RETENTION_COMPACT_FREE_PAGE_THRESHOLD) {
    return { compacted: false, freePageCount };
  }

  yield* publishRetentionMaintenance("compacting", { freePageCount });
  yield* Effect.sleep(250);
  yield* sql`PRAGMA optimize`;
  yield* sql`VACUUM`;
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  return { compacted: true, freePageCount };
});

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

export function getSoftDeletedThreadIdsForRetentionPurge(
  readModel: OrchestrationReadModel,
): ThreadId[] {
  const deletedThreadIds: ThreadId[] = [];
  for (const thread of readModel.threads) {
    if (thread.deletedAt === null) continue;
    deletedThreadIds.push(thread.id);
  }
  return deletedThreadIds;
}

const listSoftDeletedThreadIdsFromDatabase = Effect.fn(
  "listSoftDeletedThreadIdsFromDatabase",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: ThreadId }>`
    SELECT thread_id AS "threadId"
    FROM projection_threads
    WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at ASC, thread_id ASC
  `;
  return rows.map((row) => row.threadId);
});

export const runThreadRetentionSweep = Effect.fn("runThreadRetentionSweep")(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  const readModel = yield* orchestrationEngine.getReadModel();
  const inactiveThreadIds = getInactiveThreadIdsForRetention(readModel);
  const purgeThreadIds = new Set<ThreadId>([
    ...getSoftDeletedThreadIdsForRetentionPurge(readModel),
    ...(yield* listSoftDeletedThreadIdsFromDatabase().pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to list soft-deleted threads for retention purge").pipe(
          Effect.annotateLogs({ error: String(error) }),
          Effect.as([] as ThreadId[]),
        ),
      ),
    )),
  ]);
  const totalCandidateCount = inactiveThreadIds.length + purgeThreadIds.size;
  let deletedCount = 0;
  let purgedCount = 0;

  if (inactiveThreadIds.length > 0) {
    yield* publishRetentionMaintenance("started", {
      deletedCount,
      purgedCount,
      totalCount: totalCandidateCount,
    });
    yield* Effect.logInfo("deleting inactive orchestration threads").pipe(
      Effect.annotateLogs({ count: inactiveThreadIds.length }),
    );
  }

  yield* Effect.forEach(
    chunkThreadIds(inactiveThreadIds),
    (threadBatch) =>
      Effect.forEach(
        threadBatch,
        (threadId) =>
          orchestrationEngine
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.makeUnsafe(`thread-retention:${randomUUID()}`),
              threadId,
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  deletedCount += 1;
                  purgeThreadIds.add(threadId);
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("failed to delete inactive thread during retention sweep").pipe(
                  Effect.annotateLogs({
                    threadId,
                    error: String(error),
                  }),
                ),
              ),
            ),
        { concurrency: 1 },
      ).pipe(
        Effect.tap(() =>
          publishRetentionMaintenance("progress", {
            deletedCount,
            purgedCount,
            totalCount: totalCandidateCount,
          }),
        ),
        Effect.tap(() => pauseBetweenRetentionBatches),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  if (purgeThreadIds.size > 0) {
    if (inactiveThreadIds.length === 0) {
      yield* publishRetentionMaintenance("started", {
        deletedCount,
        purgedCount,
        totalCount: totalCandidateCount,
      });
    }
    yield* Effect.logInfo("purging retained deleted thread rows").pipe(
      Effect.annotateLogs({ count: purgeThreadIds.size }),
    );
  }

  yield* Effect.forEach(
    chunkThreadIds(purgeThreadIds),
    (threadBatch) =>
      Effect.forEach(
        threadBatch,
        (threadId) =>
          purgeThreadDatabaseRows(threadId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                purgedCount += 1;
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("failed to purge deleted thread database rows").pipe(
                Effect.annotateLogs({
                  threadId,
                  error: String(error),
                }),
              ),
            ),
          ),
        { concurrency: 1 },
      ).pipe(
        Effect.tap(() =>
          publishRetentionMaintenance("progress", {
            deletedCount,
            purgedCount,
            totalCount: totalCandidateCount,
          }),
        ),
        Effect.tap(() => pauseBetweenRetentionBatches),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  yield* compactDatabaseAfterRetention().pipe(
    Effect.tap(({ compacted, freePageCount }) =>
      totalCandidateCount > 0 || compacted
        ? publishRetentionMaintenance("completed", {
            deletedCount,
            purgedCount,
            totalCount: totalCandidateCount,
            freePageCount,
          })
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logWarning("failed to compact database after retention sweep").pipe(
        Effect.annotateLogs({ error: String(error) }),
        Effect.zipRight(
          publishRetentionMaintenance("failed", {
            deletedCount,
            purgedCount,
            totalCount: totalCandidateCount,
            error: String(error),
          }),
        ),
      ),
    ),
  );
});

export const startThreadRetentionJob = Effect.fn("startThreadRetentionJob")(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  // Give startup/projection bootstrap a short settling window, then run one
  // cleanup promptly so desktop installs do not need to stay open for 24 hours.
  yield* Effect.gen(function* () {
    yield* Effect.sleep(THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS);
    yield* runThreadRetentionSweep(orchestrationEngine);
    yield* Effect.forever(
      Effect.sleep(THREAD_RETENTION_SWEEP_INTERVAL_MS).pipe(
        Effect.flatMap(() => runThreadRetentionSweep(orchestrationEngine)),
      ),
      { disableYield: true },
    );
  }).pipe(Effect.forkScoped);
});
