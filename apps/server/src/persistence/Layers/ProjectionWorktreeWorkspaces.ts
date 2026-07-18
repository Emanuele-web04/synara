import {
  OrchestrationThreadPullRequest,
  WorktreeWorkspaceActiveOperation,
  WorktreeWorkspaceFailure,
} from "@synara/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionWorktreeWorkspaceInput,
  ProjectionWorktreeWorkspace,
  ProjectionWorktreeWorkspaceRepository,
  type ProjectionWorktreeWorkspaceRepositoryShape,
} from "../Services/ProjectionWorktreeWorkspaces.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const ProjectionWorktreeWorkspaceDbRow = ProjectionWorktreeWorkspace.mapFields(
  Struct.assign({
    lastKnownPr: Schema.NullOr(Schema.fromJsonString(OrchestrationThreadPullRequest)),
    isPinned: SqliteBoolean,
    activeOperation: Schema.NullOr(Schema.fromJsonString(WorktreeWorkspaceActiveOperation)),
    lastFailure: Schema.NullOr(Schema.fromJsonString(WorktreeWorkspaceFailure)),
  }),
);

const makeProjectionWorktreeWorkspaceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionWorktreeWorkspace,
    execute: (row) => sql`
      INSERT INTO projection_worktree_workspaces (
        workspace_id, project_id, repository_identity, kind, state, title, path, branch,
        head_ref, target_ref, target_resolved_commit, created_from_commit, source_kind,
        source_ref, setup_status, setup_error, setup_log_id, last_known_pr_json, is_pinned,
        lifecycle_generation, active_operation_json, last_failure_json, mutation_revision,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${row.workspaceId}, ${row.projectId}, ${row.repositoryIdentity}, ${row.kind},
        ${row.state}, ${row.title}, ${row.path}, ${row.branch}, ${row.headRef},
        ${row.targetRef}, ${row.targetResolvedCommit}, ${row.createdFromCommit},
        ${row.sourceKind}, ${row.sourceRef}, ${row.setupStatus}, ${row.setupError},
        ${row.setupLogId},
        ${row.lastKnownPr === null ? null : JSON.stringify(row.lastKnownPr)},
        ${row.isPinned ? 1 : 0}, ${row.lifecycleGeneration},
        ${row.activeOperation === null ? null : JSON.stringify(row.activeOperation)},
        ${row.lastFailure === null ? null : JSON.stringify(row.lastFailure)},
        ${row.mutationRevision}, ${row.createdAt}, ${row.updatedAt}, ${row.archivedAt},
        ${row.deletedAt}
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        project_id = excluded.project_id,
        repository_identity = excluded.repository_identity,
        kind = excluded.kind,
        state = excluded.state,
        title = excluded.title,
        path = excluded.path,
        branch = excluded.branch,
        head_ref = excluded.head_ref,
        target_ref = excluded.target_ref,
        target_resolved_commit = excluded.target_resolved_commit,
        created_from_commit = excluded.created_from_commit,
        source_kind = excluded.source_kind,
        source_ref = excluded.source_ref,
        setup_status = excluded.setup_status,
        setup_error = excluded.setup_error,
        setup_log_id = excluded.setup_log_id,
        last_known_pr_json = excluded.last_known_pr_json,
        is_pinned = excluded.is_pinned,
        lifecycle_generation = excluded.lifecycle_generation,
        active_operation_json = excluded.active_operation_json,
        last_failure_json = excluded.last_failure_json,
        mutation_revision = excluded.mutation_revision,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const selectFields = sql`
    workspace_id AS "workspaceId",
    project_id AS "projectId",
    repository_identity AS "repositoryIdentity",
    kind,
    state,
    title,
    path,
    branch,
    head_ref AS "headRef",
    target_ref AS "targetRef",
    target_resolved_commit AS "targetResolvedCommit",
    created_from_commit AS "createdFromCommit",
    source_kind AS "sourceKind",
    source_ref AS "sourceRef",
    setup_status AS "setupStatus",
    setup_error AS "setupError",
    setup_log_id AS "setupLogId",
    last_known_pr_json AS "lastKnownPr",
    is_pinned AS "isPinned",
    lifecycle_generation AS "lifecycleGeneration",
    active_operation_json AS "activeOperation",
    last_failure_json AS "lastFailure",
    mutation_revision AS "mutationRevision",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    archived_at AS "archivedAt",
    deleted_at AS "deletedAt"
  `;

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionWorktreeWorkspaceInput,
    Result: ProjectionWorktreeWorkspaceDbRow,
    execute: ({ workspaceId }) => sql`
      SELECT ${selectFields}
      FROM projection_worktree_workspaces
      WHERE workspace_id = ${workspaceId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorktreeWorkspaceDbRow,
    execute: () => sql`
      SELECT ${selectFields}
      FROM projection_worktree_workspaces
      ORDER BY created_at ASC, workspace_id ASC
    `,
  });

  const upsert: ProjectionWorktreeWorkspaceRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeWorkspaceRepository.upsert:query")),
    );
  const getById: ProjectionWorktreeWorkspaceRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeWorkspaceRepository.getById:query")),
    );
  const listAll: ProjectionWorktreeWorkspaceRepositoryShape["listAll"] = () =>
    listRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeWorkspaceRepository.listAll:query")),
    );

  return { upsert, getById, listAll } satisfies ProjectionWorktreeWorkspaceRepositoryShape;
});

export const ProjectionWorktreeWorkspaceRepositoryLive = Layer.effect(
  ProjectionWorktreeWorkspaceRepository,
  makeProjectionWorktreeWorkspaceRepository,
);
