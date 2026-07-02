// FILE: profileStatsArchive.ts
// Purpose: Snapshot a thread's profile-stat aggregates into the durable
// profile_stats_deleted_* tables, then hard-delete every row the thread owns
// (projections, events, checkpoints, session runtime). This is what lets a
// delete actually free disk space without shrinking the Profile page numbers.
// Layer: server maintenance service (SqlClient).

import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { aggregateProfileSkillUsageRows } from "./profileStats";
import { THREAD_RETENTION_COMMAND_ID_PREFIX } from "./threadRetention";

interface PurgeThreadRow {
  readonly projectId: string | null;
  readonly modelSelectionJson: string | null;
  readonly deletedAt: string | null;
}

interface TurnEventRow {
  readonly payloadJson: string | null;
}

interface TokenActivityRow {
  readonly totalProcessedTokens: number | bigint | null;
  readonly createdAt: string | null;
}

interface SkillMessageRow {
  readonly messageId: string | null;
  readonly text: string | null;
  readonly skillsJson: string | null;
  readonly mentionsJson: string | null;
}

export interface ThreadTurnSnapshotRow {
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly turnCount: number;
}

export interface ThreadTokenSnapshotRow {
  readonly createdAt: string;
  readonly tokens: number;
}

// ── Pure helpers ───────────────────────────────────────────────────────

interface ModelSelectionLike {
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoning: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseModelSelection(value: unknown): ModelSelectionLike | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as { provider?: unknown; model?: unknown; options?: unknown };
  const options =
    record.options !== null && typeof record.options === "object"
      ? (record.options as { reasoningEffort?: unknown; effort?: unknown })
      : null;
  return {
    provider: readString(record.provider),
    model: readString(record.model),
    reasoning: readString(options?.reasoningEffort) ?? readString(options?.effort),
  };
}

function parseModelSelectionJson(json: string | null): ModelSelectionLike | null {
  if (json === null || json.trim().length === 0) {
    return null;
  }
  try {
    return parseModelSelection(JSON.parse(json));
  } catch {
    return null;
  }
}

// Mirrors the per-turn extraction in profileStats.queryTurnInsights: the turn
// event's own modelSelection wins, otherwise the thread's selection applies.
export function aggregateThreadTurnSnapshotRows(
  events: ReadonlyArray<TurnEventRow>,
  threadModelSelectionJson: string | null,
): ThreadTurnSnapshotRow[] {
  const threadSelection = parseModelSelectionJson(threadModelSelectionJson);
  const counts = new Map<
    string,
    { provider: string | null; model: string | null; reasoning: string | null; turnCount: number }
  >();

  for (const event of events) {
    let eventSelection: ModelSelectionLike | null = null;
    if (event.payloadJson !== null) {
      try {
        const payload: unknown = JSON.parse(event.payloadJson);
        if (payload !== null && typeof payload === "object") {
          eventSelection = parseModelSelection(
            (payload as { modelSelection?: unknown }).modelSelection,
          );
        }
      } catch {
        // Malformed payload rows still count as a turn with the thread fallback.
      }
    }
    const selection = eventSelection ?? threadSelection;
    const provider = selection?.provider ?? null;
    const model = selection?.model ?? null;
    const reasoning = selection?.reasoning ?? null;
    const key = `${provider ?? ""}\u0000${model ?? ""}\u0000${reasoning ?? ""}`;
    const existing = counts.get(key);
    if (existing) {
      existing.turnCount += 1;
    } else {
      counts.set(key, { provider, model, reasoning, turnCount: 1 });
    }
  }

  return [...counts.values()];
}

// Mirrors the LAG-based delta in profileStats.queryTokenActivity: rows must be
// ordered the same way that query orders them, and the first total counts fully.
// Deltas keep the original activity timestamp (raw, unparsed) so read-time
// DATETIME(created_at, tz) bucketing stays identical to the live query for any
// client UTC offset.
export function aggregateThreadTokenRows(
  rows: ReadonlyArray<TokenActivityRow>,
): ThreadTokenSnapshotRow[] {
  const tokensByTimestamp = new Map<string, number>();
  let previousTotal = 0;
  for (const row of rows) {
    const total =
      typeof row.totalProcessedTokens === "bigint"
        ? Number(row.totalProcessedTokens)
        : row.totalProcessedTokens;
    if (total === null || !Number.isFinite(total)) {
      continue;
    }
    const delta = Math.max(0, total - previousTotal);
    previousTotal = total;
    if (delta <= 0 || row.createdAt === null) {
      continue;
    }
    tokensByTimestamp.set(row.createdAt, (tokensByTimestamp.get(row.createdAt) ?? 0) + delta);
  }
  return [...tokensByTimestamp.entries()].map(([createdAt, tokens]) => ({ createdAt, tokens }));
}

// ── Service ────────────────────────────────────────────────────────────

export interface ProfileStatsArchiveShape {
  // Snapshots the thread's stat aggregates and hard-deletes all of its rows in
  // one transaction. Returns false when the thread row is already gone.
  readonly purgeThreadWithStatsSnapshot: (input: {
    readonly threadId: string;
  }) => Effect.Effect<boolean, unknown>;
  // Purges every soft-deleted thread that was NOT hidden by the retention
  // sweep. Catches per-thread failures so one bad thread cannot stall the
  // sweep; returns how many threads were purged.
  readonly purgeSoftDeletedManualThreads: () => Effect.Effect<number, unknown>;
}

export class ProfileStatsArchive extends ServiceMap.Service<
  ProfileStatsArchive,
  ProfileStatsArchiveShape
>()("synara/profileStats/ProfileStatsArchive") {}

const makeProfileStatsArchive = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const snapshotAndPurgeThread = (threadId: string) =>
    Effect.gen(function* () {
      const threadRows = yield* sql<PurgeThreadRow>`
        SELECT
          project_id AS projectId,
          model_selection_json AS modelSelectionJson,
          deleted_at AS deletedAt
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      const thread = threadRows[0];
      if (!thread) {
        return false;
      }
      const deletedAt = thread.deletedAt ?? new Date().toISOString();
      const projectId = thread.projectId ?? null;

      const turnEventRows = yield* sql<TurnEventRow>`
        SELECT payload_json AS payloadJson
        FROM orchestration_events
        WHERE event_type = 'thread.turn-start-requested'
          AND COALESCE(json_extract(payload_json, '$.threadId'), stream_id) = ${threadId}
      `;
      const tokenActivityRows = yield* sql<TokenActivityRow>`
        SELECT
          CAST(json_extract(payload_json, '$.totalProcessedTokens') AS INTEGER)
            AS totalProcessedTokens,
          created_at AS createdAt
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind = 'context-window.updated'
          AND json_extract(payload_json, '$.totalProcessedTokens') IS NOT NULL
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `;
      const skillMessageRows = yield* sql<SkillMessageRow>`
        SELECT
          message_id AS messageId,
          text,
          skills_json AS skillsJson,
          mentions_json AS mentionsJson
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
          AND source = 'native'
        ORDER BY created_at ASC, message_id ASC
      `;

      const turnRows = aggregateThreadTurnSnapshotRows(turnEventRows, thread.modelSelectionJson);
      const tokenProvider = parseModelSelectionJson(thread.modelSelectionJson)?.provider ?? null;
      const tokenRows = aggregateThreadTokenRows(tokenActivityRows);
      const skillRows = aggregateProfileSkillUsageRows(skillMessageRows);

      // Snapshot writes are idempotent per thread so an interrupted purge can
      // safely re-run: wipe any partial snapshot before inserting the new one.
      yield* sql`DELETE FROM profile_stats_deleted_prompts WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM profile_stats_deleted_turns WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM profile_stats_deleted_skills WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM profile_stats_deleted_tokens WHERE thread_id = ${threadId}`;

      yield* sql`
        INSERT OR REPLACE INTO profile_stats_deleted_threads (thread_id, project_id, deleted_at)
        VALUES (${threadId}, ${projectId}, ${deletedAt})
      `;
      yield* sql`
        INSERT INTO profile_stats_deleted_prompts (thread_id, project_id, created_at)
        SELECT thread_id, ${projectId}, created_at
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
          AND source = 'native'
      `;
      yield* Effect.forEach(
        turnRows,
        (row) => sql`
          INSERT INTO profile_stats_deleted_turns (thread_id, provider, model, reasoning, turn_count)
          VALUES (${threadId}, ${row.provider}, ${row.model}, ${row.reasoning}, ${row.turnCount})
        `,
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        skillRows,
        (row) => sql`
          INSERT INTO profile_stats_deleted_skills (thread_id, name, kind, run_count)
          VALUES (${threadId}, ${row.name}, ${row.kind}, ${row.runCount})
        `,
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        tokenRows,
        (row) => sql`
          INSERT INTO profile_stats_deleted_tokens (thread_id, created_at, provider, tokens)
          VALUES (${threadId}, ${row.createdAt}, ${tokenProvider}, ${row.tokens})
        `,
        { concurrency: 1, discard: true },
      );

      // Hard delete: every table that stores rows for this thread. The event
      // delete mirrors the snapshot scope above (stream id OR payload threadId,
      // thread aggregate only) so no snapshotted event can survive the purge.
      yield* sql`
        DELETE FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND (
            stream_id = ${threadId}
            OR json_extract(payload_json, '$.threadId') = ${threadId}
          )
      `;
      yield* sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_pending_approvals WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;

      return true;
    });

  const purgeThreadWithStatsSnapshot: ProfileStatsArchiveShape["purgeThreadWithStatsSnapshot"] = (
    input,
  ) => sql.withTransaction(snapshotAndPurgeThread(input.threadId));

  const purgeSoftDeletedManualThreads: ProfileStatsArchiveShape["purgeSoftDeletedManualThreads"] =
    () =>
      Effect.gen(function* () {
        // Classify by the LATEST thread.deleted event: only threads whose most
        // recent delete came from retention stay hidden-but-kept. Soft-deleted
        // threads without any recorded delete event (legacy imports) count as
        // manual deletes and get purged too.
        const candidates = yield* sql<{ readonly threadId: string }>`
          SELECT t.thread_id AS threadId
          FROM projection_threads t
          WHERE t.deleted_at IS NOT NULL
            AND COALESCE(
              (
                SELECT td.command_id
                FROM orchestration_events td
                WHERE td.event_type = 'thread.deleted'
                  AND td.stream_id = t.thread_id
                ORDER BY td.sequence DESC
                LIMIT 1
              ),
              ''
            ) NOT LIKE ${`${THREAD_RETENTION_COMMAND_ID_PREFIX}%`}
        `;

        let purgedCount = 0;
        yield* Effect.forEach(
          candidates,
          (candidate) =>
            purgeThreadWithStatsSnapshot({ threadId: candidate.threadId }).pipe(
              Effect.flatMap((purged) =>
                Effect.sync(() => {
                  if (purged) {
                    purgedCount += 1;
                  }
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("profile stats archive failed to purge soft-deleted thread", {
                  threadId: candidate.threadId,
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
          { concurrency: 1, discard: true },
        );
        return purgedCount;
      });

  return {
    purgeThreadWithStatsSnapshot,
    purgeSoftDeletedManualThreads,
  } satisfies ProfileStatsArchiveShape;
});

export const ProfileStatsArchiveLive = Layer.effect(ProfileStatsArchive, makeProfileStatsArchive);
