import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ThreadDiagnosticsQuery,
  type DiagnosticThreadActivity,
  type OperationalDiagnostic,
  type ThreadDiagnosticsQueryShape,
} from "../Services/ThreadDiagnosticsQuery.ts";

const OPERATIONAL_DIAGNOSTIC_CAP = 10_000;

interface ActivityRow extends Omit<DiagnosticThreadActivity, "payload"> {
  readonly payloadJson: string;
}

interface OperationalDiagnosticRow extends Omit<OperationalDiagnostic, "detail"> {
  readonly detailJson: string;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { unavailable: "Stored diagnostic JSON could not be decoded." };
  }
}

const makeThreadDiagnosticsQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getActivityCoverage: ThreadDiagnosticsQueryShape["getActivityCoverage"] = (threadId) =>
    sql<{ readonly highWaterSequence: number; readonly unsequencedCount: number }>`
      SELECT
        COALESCE(MAX(sequence), 0) AS "highWaterSequence",
        COALESCE(SUM(CASE WHEN sequence IS NULL THEN 1 ELSE 0 END), 0) AS "unsequencedCount"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? { highWaterSequence: 0, unsequencedCount: 0 }),
      Effect.mapError(toPersistenceSqlError("ThreadDiagnosticsQuery.getActivityCoverage")),
    );

  const listActivities: ThreadDiagnosticsQueryShape["listActivities"] = (input) => {
    const throughSequence = input.throughSequenceInclusive ?? Number.MAX_SAFE_INTEGER;
    const beforeSequence = input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER;
    const turnId = input.turnId ?? null;
    const kindFilter =
      input.kinds === undefined || input.kinds.length === 0
        ? sql``
        : sql`AND kind IN ${sql.in(input.kinds)}`;
    return sql<ActivityRow>`
      SELECT
        activity_id AS "activityId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payloadJson",
        sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${input.threadId}
        AND sequence IS NOT NULL
        AND sequence <= ${throughSequence}
        AND sequence < ${beforeSequence}
        AND (${turnId} IS NULL OR turn_id = ${turnId})
        ${kindFilter}
      ORDER BY sequence DESC
      LIMIT ${input.limit}
    `.pipe(
      Effect.map((rows) =>
        rows.map(
          (row): DiagnosticThreadActivity => ({
            activityId: row.activityId,
            threadId: row.threadId,
            turnId: row.turnId,
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: parseJson(row.payloadJson),
            sequence: row.sequence,
            createdAt: row.createdAt,
          }),
        ),
      ),
      Effect.mapError(toPersistenceSqlError("ThreadDiagnosticsQuery.listActivities")),
    );
  };

  const recordOperationalDiagnostic: ThreadDiagnosticsQueryShape["recordOperationalDiagnostic"] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
              INSERT INTO operational_diagnostics (
                thread_id, source, diagnostic_kind, severity, code, detail_json, occurred_at
              ) VALUES (
                ${input.threadId ?? null}, ${input.source}, ${input.kind}, ${input.severity},
                ${input.code ?? null}, ${JSON.stringify(input.detail)}, ${input.occurredAt}
              )
            `;
          yield* sql`
              DELETE FROM operational_diagnostics
              WHERE occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
            `;
          yield* sql`
              DELETE FROM operational_diagnostics
              WHERE sequence <= COALESCE(
                (SELECT sequence FROM operational_diagnostics
                 ORDER BY sequence DESC LIMIT 1 OFFSET ${OPERATIONAL_DIAGNOSTIC_CAP}),
                0
              )
            `;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ThreadDiagnosticsQuery.recordOperationalDiagnostic"),
        ),
      );

  const listOperationalDiagnostics: ThreadDiagnosticsQueryShape["listOperationalDiagnostics"] = (
    input,
  ) =>
    sql<OperationalDiagnosticRow>`
      SELECT
        sequence,
        thread_id AS "threadId",
        source,
        diagnostic_kind AS "kind",
        severity,
        code,
        detail_json AS "detailJson",
        occurred_at AS "occurredAt"
      FROM operational_diagnostics
      WHERE thread_id = ${input.threadId}
        AND sequence < ${input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER}
      ORDER BY sequence DESC
      LIMIT ${input.limit}
    `.pipe(
      Effect.map((rows) =>
        rows.map(
          (row): OperationalDiagnostic => ({
            sequence: row.sequence,
            threadId: row.threadId,
            source: row.source,
            kind: row.kind,
            severity: row.severity,
            code: row.code,
            detail: parseJson(row.detailJson) as OperationalDiagnostic["detail"],
            occurredAt: row.occurredAt,
          }),
        ),
      ),
      Effect.mapError(toPersistenceSqlError("ThreadDiagnosticsQuery.listOperationalDiagnostics")),
    );

  return {
    getActivityCoverage,
    listActivities,
    recordOperationalDiagnostic,
    listOperationalDiagnostics,
  } satisfies ThreadDiagnosticsQueryShape;
});

export const ThreadDiagnosticsQueryLive = Layer.effect(
  ThreadDiagnosticsQuery,
  makeThreadDiagnosticsQuery,
);
