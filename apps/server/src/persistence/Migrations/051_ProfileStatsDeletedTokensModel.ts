/** keeps per-model attribution for purged threads' token deltas; NULL = "unknown" in ranking */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "profile_stats_deleted_tokens", "model"))) {
    yield* sql`
      ALTER TABLE profile_stats_deleted_tokens
      ADD COLUMN model TEXT
    `;
  }
});
