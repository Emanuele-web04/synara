import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { tableExists } from "./schemaHelpers.ts";

/**
 * Decouple Mind's durable tables from the derived projection. Early revisions
 * of migrations 105/107 declared `project_id REFERENCES projection_projects
 * ON DELETE CASCADE`, so `repairState`'s `DELETE FROM projection_projects`
 * erased user-authored profiles and idempotency receipts — replay recreates
 * projection rows but cannot restore deleted profile text or receipt state.
 * `mind_memories` never carried the reference; this rebuilds the two tables
 * that did. Fresh installs skip every step because 105/107 no longer declare
 * the foreign key.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const referencesProjection = (table: string) =>
    sql<{ readonly referenced: string }>`
      SELECT "table" AS referenced FROM pragma_foreign_key_list(${table})
    `.pipe(Effect.map((rows) => rows.some((row) => row.referenced === "projection_projects")));

  if (
    (yield* tableExists(sql, "mind_profiles")) &&
    (yield* referencesProjection("mind_profiles"))
  ) {
    yield* sql`DROP TABLE IF EXISTS mind_profiles_v108`;
    yield* sql`CREATE TABLE mind_profiles_v108 (
      project_id TEXT PRIMARY KEY,
      text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
      opted_in INTEGER NOT NULL DEFAULT 0 CHECK (opted_in IN (0, 1)),
      updated_at TEXT NOT NULL
    )`;
    yield* sql`INSERT INTO mind_profiles_v108 SELECT * FROM mind_profiles`;
    yield* sql`DROP TABLE mind_profiles`;
    yield* sql`ALTER TABLE mind_profiles_v108 RENAME TO mind_profiles`;
  }

  if (
    (yield* tableExists(sql, "mind_operation_receipts")) &&
    (yield* referencesProjection("mind_operation_receipts"))
  ) {
    yield* sql`DROP TABLE IF EXISTS mind_operation_receipts_v108`;
    yield* sql`CREATE TABLE mind_operation_receipts_v108 (
      project_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      op TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, operation_id)
    )`;
    yield* sql`INSERT INTO mind_operation_receipts_v108 SELECT * FROM mind_operation_receipts`;
    yield* sql`DROP TABLE mind_operation_receipts`;
    yield* sql`ALTER TABLE mind_operation_receipts_v108 RENAME TO mind_operation_receipts`;
  }
});
