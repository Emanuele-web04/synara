import { OrchestrationGoal } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadGoalInput,
  GetProjectionThreadGoalInput,
  ProjectionThreadGoal,
  ProjectionThreadGoalRepository,
  type ProjectionThreadGoalRepositoryShape,
} from "../Services/ProjectionThreadGoal.ts";

const ProjectionThreadGoalDbRow = ProjectionThreadGoal.mapFields(
  Struct.assign({ goal: Schema.fromJsonString(OrchestrationGoal) }),
);

const makeProjectionThreadGoalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadGoalRow = SqlSchema.void({
    Request: ProjectionThreadGoal,
    execute: (row) => sql`
      INSERT INTO projection_thread_goal (
        thread_id,
        goal_json,
        updated_at
      )
      VALUES (
        ${row.threadId},
        ${JSON.stringify(row.goal)},
        ${row.goal.updatedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        goal_json = excluded.goal_json,
        updated_at = excluded.updated_at
    `,
  });

  const getProjectionThreadGoalRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadGoalInput,
    Result: ProjectionThreadGoalDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        goal_json AS "goal"
      FROM projection_thread_goal
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteProjectionThreadGoalRow = SqlSchema.void({
    Request: DeleteProjectionThreadGoalInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_goal
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadGoalRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadGoalRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadGoalRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadGoalRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadGoalRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadGoalRepository.getByThreadId:query")),
    );

  const deleteByThreadId: ProjectionThreadGoalRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadGoalRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadGoalRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadGoalRepositoryShape;
});

export const ProjectionThreadGoalRepositoryLive = Layer.effect(
  ProjectionThreadGoalRepository,
  makeProjectionThreadGoalRepository,
);
