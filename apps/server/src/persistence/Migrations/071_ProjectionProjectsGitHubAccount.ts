/** Adds the selected GitHub account to durable project projections. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* columnExists(sql, "projection_projects", "github_account_json")) {
    return;
  }
  yield* sql`ALTER TABLE projection_projects ADD COLUMN github_account_json TEXT`;
});
