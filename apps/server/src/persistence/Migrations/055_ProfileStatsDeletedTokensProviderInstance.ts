// FILE: 055_ProfileStatsDeletedTokensProviderInstance.ts
// Purpose: Preserve provider-instance attribution for archived token usage.
// Layer: SQLite schema migration for archived profile statistics.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "profile_stats_deleted_tokens", "provider_instance_id"))) {
    yield* sql`
      ALTER TABLE profile_stats_deleted_tokens
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  // Legacy snapshots only retained the provider; keep that value as the best
  // available instance identity instead of folding it into an unknown bucket.
  yield* sql`
    UPDATE profile_stats_deleted_tokens
    SET provider_instance_id = provider
    WHERE provider_instance_id IS NULL
  `;
});
