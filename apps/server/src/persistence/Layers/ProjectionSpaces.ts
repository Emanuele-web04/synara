import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionSpaceInput,
  ProjectionSpace,
  ProjectionSpaceRepository,
  type ProjectionSpaceRepositoryShape,
} from "../Services/ProjectionSpaces.ts";

const makeProjectionSpaceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionSpace,
    execute: (row) => sql`
      INSERT INTO projection_spaces (
        space_id, name, icon, sort_order, created_at, updated_at, deleted_at
      ) VALUES (
        ${row.spaceId}, ${row.name}, ${row.icon}, ${row.sortOrder},
        ${row.createdAt}, ${row.updatedAt}, ${row.deletedAt}
      )
      ON CONFLICT (space_id) DO UPDATE SET
        name = excluded.name,
        icon = excluded.icon,
        sort_order = excluded.sort_order,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionSpaceInput,
    Result: ProjectionSpace,
    execute: ({ spaceId }) => sql`
      SELECT
        space_id AS "spaceId",
        name,
        icon,
        sort_order AS "sortOrder",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_spaces
      WHERE space_id = ${spaceId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSpace,
    execute: () => sql`
      SELECT
        space_id AS "spaceId",
        name,
        icon,
        sort_order AS "sortOrder",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_spaces
      ORDER BY sort_order ASC, space_id ASC
    `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionSpaceRepository.upsert:query")),
      ),
    getById: (input) =>
      getRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionSpaceRepository.getById:query")),
      ),
    listAll: () =>
      listRows().pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionSpaceRepository.listAll:query")),
      ),
  } satisfies ProjectionSpaceRepositoryShape;
});

export const ProjectionSpaceRepositoryLive = Layer.effect(
  ProjectionSpaceRepository,
  makeProjectionSpaceRepository,
);
