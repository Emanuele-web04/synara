// FILE: 059_ScrubOrchestrationEventProviderOptions.ts
// Purpose: Remove provider credentials from historical orchestration event payloads.
// Layer: SQLite data migration for the append-only event journal.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // These are the only orchestration event payloads whose contract carries
  // ProviderStartOptions. json_remove is idempotent, so an interrupted or
  // partially applied migration can safely run again.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(
      payload_json,
      '$.providerOptions.codex.environment',
      '$.providerOptions.claudeAgent.environment',
      '$.providerOptions.cursor.environment',
      '$.providerOptions.gemini.environment',
      '$.providerOptions.grok.environment',
      '$.providerOptions.kilo.environment',
      '$.providerOptions.kilo.serverPassword',
      '$.providerOptions.opencode.environment',
      '$.providerOptions.opencode.serverPassword',
      '$.providerOptions.pi.environment'
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
