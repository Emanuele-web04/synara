import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import { ModelSelection, ThreadHandoff } from "@t3tools/contracts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    handoff: Schema.NullOr(Schema.fromJsonString(ThreadHandoff)),
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          env_mode,
          branch,
          worktree_path,
          associated_worktree_path,
          associated_worktree_branch,
          associated_worktree_ref,
          fork_source_thread_id,
          latest_turn_id,
          handoff_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.envMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.associatedWorktreePath},
          ${row.associatedWorktreeBranch},
          ${row.associatedWorktreeRef},
          ${row.forkSourceThreadId ?? null},
          ${row.latestTurnId},
          ${row.handoff === null ? null : JSON.stringify(row.handoff)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          env_mode = excluded.env_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          associated_worktree_path = excluded.associated_worktree_path,
          associated_worktree_branch = excluded.associated_worktree_branch,
          associated_worktree_ref = excluded.associated_worktree_ref,
          fork_source_thread_id = excluded.fork_source_thread_id,
          latest_turn_id = excluded.latest_turn_id,
          handoff_json = excluded.handoff_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          fork_source_thread_id AS "forkSourceThreadId",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          fork_source_thread_id AS "forkSourceThreadId",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
