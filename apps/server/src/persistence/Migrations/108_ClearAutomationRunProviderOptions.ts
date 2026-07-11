// FILE: 108_ClearAutomationRunProviderOptions.ts
// Purpose: Migrate queued-run account identity before removing legacy launch snapshots.
// Layer: SQLite data migration for automation persistence.

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { parseJson, resolveAutomationProviderIdentity } from "./automationProviderIdentity.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{
    readonly runId: string;
    readonly status: string;
    readonly permissionSnapshotJson: string;
  }>`
    SELECT
      run_id AS "runId",
      status,
      permission_snapshot_json AS "permissionSnapshotJson"
    FROM automation_runs
    WHERE NOT json_valid(permission_snapshot_json)
       OR json_type(permission_snapshot_json, '$.providerOptions') IS NOT NULL
  `;
  const migratedAt = new Date(yield* Clock.currentTimeMillis).toISOString();

  for (const row of rows) {
    const snapshot = parseJson(row.permissionSnapshotJson);
    const snapshotRecord =
      snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? (snapshot as Record<string, unknown>)
        : null;
    const resolution = snapshotRecord
      ? resolveAutomationProviderIdentity(
          snapshotRecord.modelSelection,
          snapshotRecord.providerOptions,
          snapshotRecord.provider,
        )
      : { safe: false as const };
    if (snapshotRecord) {
      const sanitizedSnapshot: Record<string, unknown> = {
        ...snapshotRecord,
        ...(resolution.safe ? { modelSelection: resolution.modelSelection } : {}),
      };
      delete sanitizedSnapshot.providerOptions;
      yield* sql`
        UPDATE automation_runs
        SET permission_snapshot_json = ${JSON.stringify(sanitizedSnapshot)}
        WHERE run_id = ${row.runId}
      `;
    }

    if (
      !resolution.safe &&
      (row.status === "pending" ||
        row.status === "claimed" ||
        row.status === "running" ||
        row.status === "waiting-for-approval")
    ) {
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
        WHERE run_id = ${row.runId}
      `;
    }
  }
});
