import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectId, ProjectImportProvider, ThreadId } from "@synara/contracts";

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
  return { list, find, reserve, complete, listNativeBindings };
});

export type ProjectImportRepository = Effect.Success<typeof makeProjectImportRepository>;
