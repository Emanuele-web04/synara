// FILE: 099_ExternalAgentLifecycle.ts
// Purpose: KAR-529 persisted lifecycle state for external agent profiles.
// Adds the lifecycle/trust columns to `external_agent_profiles` and the
// attribution columns (external agent revision + spawning profile) to
// `projection_turns` so turn logs can be traced back to the exact external
// agent revision that produced them.

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

  // Backfill attribution for already-persisted external-agent turns from the
  // thread's model selection. The model selection JSON (projection_threads,
  // migration 016) contains `profileId` + `revisionId` for external providers;
  // fill NULL rows so existing history is attributable without waiting for a
  // new turn. Deterministic and idempotent.
  yield* sql`
    UPDATE projection_turns
    SET
      external_agent_revision_id = json_extract(thread_model_selection.model_selection_json, '$.revisionId'),
      spawning_profile_id = json_extract(thread_model_selection.model_selection_json, '$.profileId')
    FROM (
      SELECT
        pt.row_id AS turn_row_id,
        th.model_selection_json AS model_selection_json
      FROM projection_turns AS pt
      JOIN projection_threads AS th ON th.thread_id = pt.thread_id
      WHERE pt.external_agent_revision_id IS NULL
        AND json_extract(th.model_selection_json, '$.provider') = 'external'
    ) AS thread_model_selection
    WHERE projection_turns.row_id = thread_model_selection.turn_row_id
  `;
});
