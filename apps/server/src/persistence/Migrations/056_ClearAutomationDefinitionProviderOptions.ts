// FILE: 056_ClearAutomationDefinitionProviderOptions.ts
// Purpose: Migrate automation account identity before removing legacy launch snapshots.
// Layer: SQLite data migration for automation persistence.

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeUnresolvedAutomationModelSelection,
  parseJson,
  resolveAutomationProviderIdentity,
} from "./automationProviderIdentity.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{
    readonly automationId: string;
    readonly modelSelectionJson: string;
    readonly providerOptionsJson: string;
  }>`
    SELECT
      automation_id AS "automationId",
      model_selection_json AS "modelSelectionJson",
      provider_options_json AS "providerOptionsJson"
    FROM automation_definitions
    WHERE provider_options_json IS NOT NULL
  `;
  const migratedAt = new Date(yield* Clock.currentTimeMillis).toISOString();

  for (const row of rows) {
    const resolution = resolveAutomationProviderIdentity(
      parseJson(row.modelSelectionJson),
      parseJson(row.providerOptionsJson),
    );
    if (resolution.safe) {
      yield* sql`
        UPDATE automation_definitions
        SET model_selection_json = ${JSON.stringify(resolution.modelSelection)},
            provider_options_json = NULL
        WHERE automation_id = ${row.automationId}
      `;
      continue;
    }

    const unresolved = makeUnresolvedAutomationModelSelection(
      parseJson(row.modelSelectionJson),
      parseJson(row.providerOptionsJson),
    );
    // No settings snapshot is available inside a SQL migration. Fail closed
    // rather than let a legacy home/env/server override fall back to the
    // provider's default account after provider_options_json is removed.
    yield* sql`
      UPDATE automation_definitions
      SET enabled = 0,
          next_run_at = NULL,
          model_selection_json = ${JSON.stringify(unresolved.modelSelection)},
          provider_options_json = NULL
      WHERE automation_id = ${row.automationId}
    `;
    yield* sql`
      UPDATE automation_runs
      SET status = 'interrupted',
          error = COALESCE(
            error,
            'Automation stopped during provider account migration because its saved account could not be mapped safely.'
          ),
          finished_at = ${migratedAt},
          updated_at = ${migratedAt},
          lease_expires_at = NULL,
          claimed_by = NULL
      WHERE automation_id = ${row.automationId}
        AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
    `;
  }
});
