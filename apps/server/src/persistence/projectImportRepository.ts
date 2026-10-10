import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectImportProvider,
  ProviderInstanceId,
  ThreadHandoffImportedMessage,
  ThreadId,
  type ProjectId,
} from "@synara/contracts";

export const ProjectImportHistoryState = Schema.Struct({
  threadId: ThreadId,
  provider: ProjectImportProvider,
  providerInstanceId: ProviderInstanceId,
  nativeId: Schema.String,
  sourceHome: Schema.String,
  sourceCwd: Schema.String,
  sourceCreatedAt: IsoDateTime,
  cwd: Schema.optional(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  before: Schema.NullOr(IsoDateTime),
  revision: NonNegativeInt,
  // Persist before dispatch so a crash retries exactly the same messages.
  pending: Schema.NullOr(
    Schema.Struct({
      messages: Schema.Array(ThreadHandoffImportedMessage),
      nextCursor: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ProjectImportHistoryState = typeof ProjectImportHistoryState.Type;

export interface ProjectImportOrigin {
  readonly sourceKey: string;
  readonly provider: ProjectImportProvider;
  readonly sourceHome: string;
  readonly externalId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly status: "pending" | "completed";
  readonly createdAt: string;
}

export const makeProjectImportRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = () => sql<ProjectImportOrigin>`
    SELECT source_key AS "sourceKey", provider, source_home AS "sourceHome",
      external_id AS "externalId", project_id AS "projectId", thread_id AS "threadId",
      status, created_at AS "createdAt"
    FROM project_import_origins
  `;
  const reserve = (origin: ProjectImportOrigin, replacingThreadId?: ThreadId) =>
    sql<ProjectImportOrigin>`
    INSERT INTO project_import_origins
      (source_key, provider, source_home, external_id, project_id, thread_id, status, created_at)
    VALUES (${origin.sourceKey}, ${origin.provider}, ${origin.sourceHome}, ${origin.externalId},
      ${origin.projectId}, ${origin.threadId}, 'pending', ${origin.createdAt})
    ON CONFLICT(source_key) DO UPDATE SET
      project_id = excluded.project_id, thread_id = excluded.thread_id,
      status = 'pending', created_at = excluded.created_at
    WHERE project_import_origins.thread_id = ${replacingThreadId ?? null}
    RETURNING source_key AS "sourceKey", provider, source_home AS "sourceHome",
      external_id AS "externalId", project_id AS "projectId", thread_id AS "threadId",
      status, created_at AS "createdAt"
  `.pipe(Effect.map((rows) => rows[0]));
  const find = (sourceKey: string) =>
    sql<ProjectImportOrigin>`
    SELECT source_key AS "sourceKey", provider, source_home AS "sourceHome",
      external_id AS "externalId", project_id AS "projectId", thread_id AS "threadId",
      status, created_at AS "createdAt"
    FROM project_import_origins WHERE source_key = ${sourceKey}
  `.pipe(Effect.map((rows) => rows[0]));
  const complete = (sourceKey: string) =>
    sql`
    UPDATE project_import_origins SET status = 'completed' WHERE source_key = ${sourceKey}
  `.pipe(Effect.asVoid);
  const getHistory = (threadId: ThreadId, revision = 0) =>
    sql<{ state: string }>`
    SELECT h.state_json AS state FROM project_import_history h
    JOIN project_import_origins o ON o.thread_id = h.thread_id
    WHERE h.thread_id = ${threadId} AND h.revision = ${revision}
  `.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectImportHistoryState))(
              rows[0].state,
            )
          : Effect.succeed(undefined),
      ),
    );
  // The previous importer committed oldest-first batches before a history ledger
  // existed. Only an accepted legacy receipt identifies that upgrade case.
  const getLegacyMessages = (threadId: ThreadId) =>
    sql<{ messageId: string; createdAt: string }>`
      SELECT message_id AS "messageId", created_at AS "createdAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND EXISTS (
        SELECT 1 FROM orchestration_command_receipts
        WHERE command_id = ${`project-import:${threadId}:messages:0`} AND status = 'accepted'
      )
      ORDER BY created_at, message_id
    `;
  const saveHistory = (state: ProjectImportHistoryState) =>
    sql`
    INSERT INTO project_import_history (thread_id, revision, state_json)
    VALUES (${state.threadId}, ${state.revision}, ${JSON.stringify(state)})
    ON CONFLICT(thread_id, revision) DO UPDATE SET state_json = excluded.state_json
  `.pipe(Effect.asVoid);
  const isCompleted = (threadId: ThreadId) =>
    sql<{ status: string }>`
    SELECT status FROM project_import_origins WHERE thread_id = ${threadId}
  `.pipe(Effect.map((rows) => rows[0]?.status === "completed"));
  const listNativeBindings = () => sql<{
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly provider: string;
    readonly cursor: string | null;
  }>`
    SELECT r.thread_id AS "threadId", t.project_id AS "projectId",
      r.provider_name AS provider, r.resume_cursor_json AS cursor
    FROM provider_session_runtime r JOIN projection_threads t ON t.thread_id = r.thread_id
  `;
  return {
    list,
    find,
    reserve,
    complete,
    listNativeBindings,
    getHistory,
    getLegacyMessages,
    saveHistory,
    isCompleted,
  };
});

export type ProjectImportRepository = Effect.Success<typeof makeProjectImportRepository>;
