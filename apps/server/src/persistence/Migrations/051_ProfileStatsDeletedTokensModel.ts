/**
 * Adds `model` to the profile_stats_deleted_tokens archive so token deltas of
 * purged threads keep their per-model attribution and can feed the token-based
 * model-usage ranking. Nullable: legacy snapshots without a model count as
 * "unknown" in that ranking.
 */
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
