// FILE: 109_ScrubOrchestrationEventProviderOptions.ts
// Purpose: Remove provider credentials from historical orchestration event payloads.
// Layer: SQLite data migration for the append-only event journal.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // These are the only orchestration event payloads whose contract carries
  // ProviderStartOptions. Keep an empty environment isolation marker while
  // removing its values; both operations are idempotent after a partial run.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(
      json_replace(
        payload_json,
        '$.providerOptions.codex.environment', json('{}'),
        '$.providerOptions.claudeAgent.environment', json('{}'),
        '$.providerOptions.cursor.environment', json('{}'),
        '$.providerOptions.devin.environment', json('{}'),
        '$.providerOptions.antigravity.environment', json('{}'),
        '$.providerOptions.grok.environment', json('{}'),
        '$.providerOptions.droid.environment', json('{}'),
        '$.providerOptions.opencode.environment', json('{}'),
        '$.providerOptions.pi.environment', json('{}')
      ),
      '$.providerOptions.opencode.serverPassword'
    )
    WHERE event_type IN (
      'thread.turn-queued',
      'thread.turn-start-requested',
      'thread.message-edit-resend-requested'
    )
      AND json_valid(payload_json)
      AND json_type(payload_json, '$.providerOptions') = 'object'
  `;
});
