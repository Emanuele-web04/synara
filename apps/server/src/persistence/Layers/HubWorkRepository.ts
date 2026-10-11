import { HubWorkRecord, ProjectId } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  HubWorkRepository,
  HubWorkRepositoryError,
  type HubWorkRepositoryShape,
} from "../Services/HubWorkRepository";

type RecordRow = { readonly recordJson: string };
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(HubWorkRecord));
const storageError = (cause: unknown) =>
  cause instanceof HubWorkRepositoryError
    ? cause
    : new HubWorkRepositoryError({
        message: "Could not persist hub work.",
        code: "storage",
        cause,
      });
const conflict = (message: string) => new HubWorkRepositoryError({ message, code: "conflict" });

export const makeHubWorkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decodeRows = (rows: readonly RecordRow[]) =>
    Effect.forEach(rows, (row) => decodeRecord(row.recordJson));
  const readOne = (rows: readonly RecordRow[]) =>
    rows[0] ? decodeRecord(rows[0].recordJson) : Effect.succeed(null);

  const availableCapacity = sql`(
              (SELECT COUNT(*) FROM project_agent_work_items held
                WHERE held.project_id = queued.project_id AND held.slot_held = 1)
              + (SELECT COUNT(*) FROM (
                  SELECT assigned_thread_id AS thread_id FROM project_agent_tasks
                    WHERE project_id = queued.project_id AND status = 'running' AND archived_at IS NULL
                      AND assigned_thread_id IS NOT NULL
                  UNION
                  SELECT thread_id FROM project_agent_managed_workers
                    WHERE project_id = queued.project_id AND settled_at IS NULL
                ) legacy WHERE NOT EXISTS (
                  SELECT 1 FROM project_agent_work_items tracked WHERE tracked.worker_thread_id = legacy.thread_id
                ))
            ) < MIN(8, COALESCE(json_extract(config.limits_json, '$.maxConcurrentWorkers'), 8))`;

  const repository: HubWorkRepositoryShape = {
    submit: (records) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const first = records[0];
            if (!first) return { items: [], replayed: false };
            if (
              records.some(
                (record) =>
                  record.projectId !== first.projectId ||
                  record.requestId !== first.requestId ||
                  record.scopeKey !== first.scopeKey ||
                  record.fingerprint !== first.fingerprint,
              )
            ) {
              return yield* Effect.fail(
                conflict("All hub tasks must belong to the same frozen request."),
              );
            }
            const [request] = yield* sql<{
              readonly scopeKey: string;
              readonly fingerprint: string;
            }>`
              SELECT scope_key AS "scopeKey", fingerprint FROM project_agent_work_requests
              WHERE project_id = ${first.projectId} AND request_id = ${first.requestId}
            `;
            if (
              request &&
              (request.scopeKey !== first.scopeKey || request.fingerprint !== first.fingerprint)
            ) {
              return yield* Effect.fail(
                conflict("This request ID already belongs to a different hub work plan."),
              );
            }
            const existing = yield* sql<RecordRow>`
        SELECT record_json AS "recordJson" FROM project_agent_work_items
        WHERE project_id = ${first.projectId} AND scope_key = ${first.scopeKey}
        ORDER BY task_index
      `.pipe(Effect.flatMap(decodeRows));
            if (existing.length > 0) {
              if (
                existing.length !== records.length ||
                existing.some((record) => record.fingerprint !== first.fingerprint)
              ) {
                return yield* Effect.fail(
                  conflict("This request already has a different hub work plan."),
                );
              }
              yield* sql`
                INSERT OR IGNORE INTO project_agent_work_requests (project_id, request_id, scope_key, fingerprint)
                VALUES (${first.projectId}, ${first.requestId}, ${first.scopeKey}, ${first.fingerprint})
              `;
              return { items: existing, replayed: true };
            }
            for (const record of records) {
              yield* sql`
          INSERT INTO project_agent_work_items
            (work_item_id, project_id, scope_key, task_index, state, worker_thread_id, slot_held, revision, record_json)
          VALUES (${record.id}, ${record.projectId}, ${record.scopeKey}, ${record.taskIndex},
            ${record.state}, ${record.workerThreadId}, ${record.slotHeld ? 1 : 0}, ${record.revision}, ${JSON.stringify(record)})
        `;
            }
            yield* sql`
              INSERT INTO project_agent_work_requests (project_id, request_id, scope_key, fingerprint)
              VALUES (${first.projectId}, ${first.requestId}, ${first.scopeKey}, ${first.fingerprint})
            `;
            return { items: records, replayed: false };
          }),
        )
        .pipe(Effect.mapError(storageError)),

    list: (projectId) =>
      sql<RecordRow>`
      SELECT record_json AS "recordJson" FROM project_agent_work_items
      WHERE project_id = ${projectId} ORDER BY sequence
    `.pipe(Effect.flatMap(decodeRows), Effect.mapError(storageError)),

    get: (id) =>
      sql<RecordRow>`
      SELECT record_json AS "recordJson" FROM project_agent_work_items WHERE work_item_id = ${id}
    `.pipe(Effect.flatMap(readOne), Effect.mapError(storageError)),

    findByWorker: (threadId) =>
      sql<RecordRow>`
      SELECT record_json AS "recordJson" FROM project_agent_work_items WHERE worker_thread_id = ${threadId}
    `.pipe(Effect.flatMap(readOne), Effect.mapError(storageError)),

    listQueuedProjects: () =>
      sql<{ readonly projectId: string }>`
      SELECT DISTINCT project_id AS "projectId" FROM project_agent_work_items WHERE state = 'queued'
    `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(ProjectId)(row.projectId)),
        ),
        Effect.mapError(storageError),
      ),

    listPendingProjects: () =>
      sql<{ readonly projectId: string }>`
      SELECT DISTINCT project_id AS "projectId" FROM project_agent_work_items WHERE state IN ('queued', 'starting', 'working', 'waiting', 'idle')
    `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(ProjectId)(row.projectId)),
        ),
        Effect.mapError(storageError),
      ),

    claimNext: (projectId) => {
      const now = new Date().toISOString();
      return sql<RecordRow>`
        UPDATE project_agent_work_items
        SET state = 'starting', slot_held = 1, revision = revision + 1,
          record_json = json_set(record_json, '$.state', 'starting', '$.slotHeld', json('true'),
            '$.queueReason', NULL, '$.revision', revision + 1, '$.updatedAt', ${now}, '$.admittedAt', ${now})
        WHERE work_item_id = (
          SELECT queued.work_item_id FROM project_agent_work_items queued
          JOIN project_agent_configs config ON config.project_id = queued.project_id
          WHERE queued.project_id = ${projectId} AND queued.state = 'queued'
            AND config.enabled = 1 AND config.paused_at IS NULL AND config.archived_at IS NULL
            AND (
              json_extract(queued.record_json, '$.targetProjectId') = queued.project_id
              OR EXISTS (
                SELECT 1 FROM project_agent_linked_projects linked
                WHERE linked.project_id = queued.project_id
                  AND linked.linked_project_id = json_extract(queued.record_json, '$.targetProjectId')
              )
            )
            AND ${availableCapacity}
          ORDER BY queued.sequence LIMIT 1
        )
        RETURNING record_json AS "recordJson"
      `.pipe(Effect.flatMap(readOne), Effect.mapError(storageError));
    },

    reserveWorker: (input) => {
      const now = new Date().toISOString();
      return sql<RecordRow>`
        UPDATE project_agent_work_items
        SET state = 'starting', slot_held = 1, revision = revision + 1,
          record_json = json_set(record_json, '$.state', 'starting', '$.slotHeld', json('true'),
            '$.queueReason', NULL, '$.revision', revision + 1, '$.updatedAt', ${now}, '$.admittedAt', ${now},
            '$.admissionCommandId', ${input.commandId}, '$.admissionMessageId', ${input.messageId},
            '$.admissionPreviousState', state, '$.admissionPreviousSlotHeld', json(CASE WHEN slot_held = 1 THEN 'true' ELSE 'false' END))
        WHERE work_item_id = (
          SELECT queued.work_item_id FROM project_agent_work_items queued
          JOIN project_agent_configs config ON config.project_id = queued.project_id
          WHERE queued.worker_thread_id = ${input.threadId}
            AND (queued.state != 'starting' OR json_extract(queued.record_json, '$.admissionCommandId') IS NULL)
            AND queued.state IN ('idle', 'completed', 'failed', 'waiting', 'working', 'starting')
            AND config.enabled = 1 AND config.paused_at IS NULL AND config.archived_at IS NULL
            AND (
              json_extract(queued.record_json, '$.targetProjectId') = queued.project_id
              OR EXISTS (SELECT 1 FROM project_agent_linked_projects linked
                WHERE linked.project_id = queued.project_id
                AND linked.linked_project_id = json_extract(queued.record_json, '$.targetProjectId'))
            )
            AND (queued.slot_held = 1 OR ${availableCapacity})
        ) RETURNING record_json AS "recordJson"
      `.pipe(Effect.flatMap(readOne), Effect.mapError(storageError));
    },

    save: ({ record, expectedRevision }) => {
      if (record.revision !== expectedRevision + 1)
        return Effect.fail(conflict("Hub work revisions must advance once."));
      return sql<RecordRow>`
        UPDATE project_agent_work_items
        SET state = ${record.state}, worker_thread_id = ${record.workerThreadId},
          slot_held = ${record.slotHeld ? 1 : 0}, revision = ${record.revision}, record_json = ${JSON.stringify(record)}
        WHERE work_item_id = ${record.id} AND revision = ${expectedRevision}
        RETURNING record_json AS "recordJson"
      `.pipe(
        Effect.mapError(storageError),
        Effect.flatMap(
          (rows): Effect.Effect<HubWorkRecord, HubWorkRepositoryError> =>
            rows[0]
              ? decodeRecord(rows[0].recordJson).pipe(Effect.mapError(storageError))
              : Effect.fail(conflict("Hub work changed. Reload and retry.")),
        ),
      );
    },

    deleteProject: (projectId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM project_agent_work_requests WHERE project_id = ${projectId}`;
            yield* sql`DELETE FROM project_agent_work_items WHERE project_id = ${projectId}`;
          }),
        )
        .pipe(Effect.mapError(storageError)),
  };
  return repository;
});

export const HubWorkRepositoryLive = Layer.effect(HubWorkRepository, makeHubWorkRepository);
