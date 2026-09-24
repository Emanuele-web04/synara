import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  ClearActiveToolsInput,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
  GetToolInFlightInput,
  MarkToolFinishedInput,
  MarkToolStartedInput,
  ToolInFlight,
  TouchLastActivityInput,
} from "../Services/ProjectionThreadSessions.ts";

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          runtime_mode,
          active_turn_id,
          last_error,
          last_activity_at,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.runtimeMode},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.lastActivityAt},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          last_activity_at = MAX(
            COALESCE(projection_thread_sessions.last_activity_at, excluded.last_activity_at),
            COALESCE(excluded.last_activity_at, projection_thread_sessions.last_activity_at)
          ),
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSession,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          last_activity_at AS "lastActivityAt",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const touchLastActivityRow = SqlSchema.void({
    Request: TouchLastActivityInput,
    execute: ({ threadId, activityAt }) =>
      sql`
        UPDATE projection_thread_sessions
        SET last_activity_at = MAX(COALESCE(last_activity_at, ${activityAt}), ${activityAt})
        WHERE thread_id = ${threadId}
      `,
  });

  const markToolStartedRow = SqlSchema.void({
    Request: MarkToolStartedInput,
    execute: (row) =>
      sql`
        INSERT OR IGNORE INTO projection_thread_active_tools (
          thread_id, item_id, turn_id, started_at, started_event_id
        )
        VALUES (
          ${row.threadId}, ${row.itemId}, ${row.turnId}, ${row.startedAt}, ${row.startedEventId}
        )
      `,
  });

  const markToolFinishedRow = SqlSchema.void({
    Request: MarkToolFinishedInput,
    execute: ({ threadId, itemId }) =>
      sql`
        DELETE FROM projection_thread_active_tools
        WHERE thread_id = ${threadId} AND item_id = ${itemId}
      `,
  });

  const clearActiveToolsRows = SqlSchema.void({
    Request: ClearActiveToolsInput,
    execute: ({ threadId, exceptTurnId }) =>
      exceptTurnId === undefined || exceptTurnId === null
        ? sql`
          DELETE FROM projection_thread_active_tools
          WHERE thread_id = ${threadId}
        `
        : sql`
          DELETE FROM projection_thread_active_tools
          WHERE thread_id = ${threadId} AND (turn_id IS NULL OR turn_id != ${exceptTurnId})
        `,
  });

  const getToolInFlightRows = SqlSchema.findAll({
    Request: GetToolInFlightInput,
    Result: ToolInFlight,
    execute: ({ threadId }) =>
      sql`
        SELECT
          item_id AS "itemId",
          turn_id AS "turnId",
          started_at AS "startedAt"
        FROM projection_thread_active_tools
        WHERE thread_id = ${threadId}
        ORDER BY started_at ASC, item_id ASC
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  const touchLastActivity: ProjectionThreadSessionRepositoryShape["touchLastActivity"] = (input) =>
    touchLastActivityRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.touchLastActivity:query"),
      ),
    );

  const markToolStarted: ProjectionThreadSessionRepositoryShape["markToolStarted"] = (input) =>
    markToolStartedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.markToolStarted:query"),
      ),
    );

  const markToolFinished: ProjectionThreadSessionRepositoryShape["markToolFinished"] = (input) =>
    markToolFinishedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.markToolFinished:query"),
      ),
    );

  const clearActiveTools: ProjectionThreadSessionRepositoryShape["clearActiveTools"] = (input) =>
    clearActiveToolsRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.clearActiveTools:query"),
      ),
    );

  const getToolInFlight: ProjectionThreadSessionRepositoryShape["getToolInFlight"] = (input) =>
    getToolInFlightRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getToolInFlight:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
    touchLastActivity,
    markToolStarted,
    markToolFinished,
    clearActiveTools,
    getToolInFlight,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
