/**
 * Adds durable pin state to projected projects so project sidebar pins survive
 * browser restarts and can be reflected in shell snapshots.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (yield* columnExists(sql, "projection_projects", "is_pinned")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
  `;
});
