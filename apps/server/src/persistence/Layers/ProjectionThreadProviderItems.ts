import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { OrchestrationProviderItem } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadProviderItemsInput,
  ListProjectionThreadProviderItemsInput,
  ProjectionThreadProviderItem,
  ProjectionThreadProviderItemRepository,
  type ProjectionThreadProviderItemRepositoryShape,
} from "../Services/ProjectionThreadProviderItems.ts";

const ProjectionThreadProviderItemDbRowSchema = ProjectionThreadProviderItem.mapFields(
  Struct.assign({
    item: Schema.fromJsonString(OrchestrationProviderItem),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadProviderItemRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadProviderItemRow = SqlSchema.void({
    Request: ProjectionThreadProviderItem,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_provider_items (
          provider_item_id,
          thread_id,
          turn_id,
          item_json,
          created_at,
          updated_at
        )
        VALUES (
          ${row.providerItemId},
          ${row.threadId},
          ${row.turnId},
          ${JSON.stringify(row.item)},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (provider_item_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          item_json = excluded.item_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const listProjectionThreadProviderItemRows = SqlSchema.findAll({
    Request: ListProjectionThreadProviderItemsInput,
    Result: ProjectionThreadProviderItemDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          provider_item_id AS "providerItemId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          item_json AS "item",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_provider_items
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, provider_item_id ASC
      `,
  });

  const deleteProjectionThreadProviderItemRows = SqlSchema.void({
    Request: DeleteProjectionThreadProviderItemsInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_provider_items
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadProviderItemRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadProviderItemRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadProviderItemRepository.upsert:query",
          "ProjectionThreadProviderItemRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadProviderItemRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadProviderItemRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadProviderItemRepository.listByThreadId:query",
          "ProjectionThreadProviderItemRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const deleteByThreadId: ProjectionThreadProviderItemRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadProviderItemRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProviderItemRepository.deleteByThreadId"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadProviderItemRepositoryShape;
});

export const ProjectionThreadProviderItemRepositoryLive = Layer.effect(
  ProjectionThreadProviderItemRepository,
  makeProjectionThreadProviderItemRepository,
);
