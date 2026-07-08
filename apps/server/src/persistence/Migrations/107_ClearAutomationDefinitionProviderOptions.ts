// FILE: 107_ClearAutomationDefinitionProviderOptions.ts
// Purpose: Remove stale or secret launch snapshots from automation definitions.
// Layer: SQLite data migration for automation persistence.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Model selections carry the provider instance id; launch configuration is
  // resolved from current server settings whenever the automation runs.
  yield* sql`
    UPDATE automation_definitions
    SET provider_options_json = NULL
    WHERE provider_options_json IS NOT NULL
  `;
});
