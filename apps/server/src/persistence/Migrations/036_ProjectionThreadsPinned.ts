/**
 * Adds durable pin state to projected threads so server-side retention can
 * protect pinned conversations without depending on browser local storage.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (yield* columnExists(sql, "projection_threads", "is_pinned")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
  `;
});
