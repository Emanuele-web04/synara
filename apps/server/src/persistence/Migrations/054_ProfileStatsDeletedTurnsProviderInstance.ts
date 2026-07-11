// FILE: 054_ProfileStatsDeletedTurnsProviderInstance.ts
// Purpose: Preserve provider-instance attribution after profile thread purges.
// Layer: SQLite schema migration for archived profile statistics.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "profile_stats_deleted_turns", "provider_instance_id"))) {
    yield* sql`
      ALTER TABLE profile_stats_deleted_turns
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  // Older archive rows used the provider field for both built-in providers and
  // opaque instance ids, so it is the safest available instance fallback.
  yield* sql`
    UPDATE profile_stats_deleted_turns
    SET provider_instance_id = provider
    WHERE provider_instance_id IS NULL
  `;
});
