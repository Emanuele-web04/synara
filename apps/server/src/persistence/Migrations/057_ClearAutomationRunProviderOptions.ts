// FILE: 057_ClearAutomationRunProviderOptions.ts
// Purpose: Remove stale or secret launch snapshots from historical automation runs.
// Layer: SQLite data migration for automation persistence.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE automation_runs
    SET permission_snapshot_json = json_remove(permission_snapshot_json, '$.providerOptions')
    WHERE json_valid(permission_snapshot_json)
      AND json_type(permission_snapshot_json, '$.providerOptions') IS NOT NULL
  `;
});
