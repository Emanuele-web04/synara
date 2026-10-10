// FILE: 134_ExternalAgentLifecycle.ts
// Purpose: KAR-529 persisted lifecycle state for external agent profiles.
// Adds the lifecycle/trust columns to `external_agent_profiles` and the
// attribution columns (external agent revision + spawning profile) to
// `projection_turns` so turn logs can be traced back to the exact external
// agent revision that produced them. Also normalizes KAR-522's legacy
// `tombstoned` status rows to `retired` so the tight status contract keeps
// decoding after migration.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Profile lifecycle metadata. `status` already exists (KAR-522); the new
  // columns record the reason/timestamp of the most recent lifecycle event
  // (quarantine / re-certify / retire) and the effective trust derived from
  // the pinned revision's provenance.
  if (!(yield* columnExists(sql, "external_agent_profiles", "lifecycle_event_json"))) {
    yield* sql`
      ALTER TABLE external_agent_profiles
      ADD COLUMN lifecycle_event_json TEXT
    `;
  }
  if (!(yield* columnExists(sql, "external_agent_profiles", "trust_json"))) {
    yield* sql`
      ALTER TABLE external_agent_profiles
      ADD COLUMN trust_json TEXT
    `;
  }

  // Turn-log attribution (KAR-529 AC #4). The projection_turns table already
  // carries turn metadata; these two nullable columns pin each turn row to the
  // external agent revision and the spawning profile that produced it. NULL for
  // non-external (built-in provider) turns.
  if (!(yield* columnExists(sql, "projection_turns", "external_agent_revision_id"))) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN external_agent_revision_id TEXT
    `;
  }
  if (!(yield* columnExists(sql, "projection_turns", "spawning_profile_id"))) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN spawning_profile_id TEXT
    `;
  }

  // Normalize legacy `tombstoned` rows (written by the KAR-522 base) to
  // `retired`. The AgentProfileStatus contract only decodes active /
  // quarantined / retired, so a tombstoned row left behind would throw on
  // every profile read after this schema lands. Bounded to tombstoned rows
  // and idempotent: re-running touches nothing.
  yield* sql`
    UPDATE external_agent_profiles
    SET status = 'retired'
    WHERE status = 'tombstoned'
  `;

  // Historical turns cannot be attributed from the thread's current model:
  // the profile may have changed after those turns. Leave unknown identities
  // NULL; newly projected turn-start events carry their own pinned identity.
});
