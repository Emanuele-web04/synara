import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!columns.some((column) => column.name === "provider_instance_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  // Legacy payloads stored modelSelection as { provider, model, options }.
  // Recovery decodes it with the current ModelSelection schema (which
  // requires instanceId), so canonicalize the JSON in place — otherwise
  // resumed/forked sessions silently lose their saved model/options.
  yield* sql`
    UPDATE provider_session_runtime
    SET runtime_payload_json = json_remove(
      json_set(
        runtime_payload_json,
        '$.modelSelection.instanceId',
        json_extract(runtime_payload_json, '$.modelSelection.provider')
      ),
      '$.modelSelection.provider'
    )
    WHERE json_extract(runtime_payload_json, '$.modelSelection.provider') IS NOT NULL
      AND json_extract(runtime_payload_json, '$.modelSelection.instanceId') IS NULL
  `;

  yield* sql`
    UPDATE provider_session_runtime
    SET provider_instance_id = COALESCE(
      json_extract(runtime_payload_json, '$.providerInstanceId'),
      json_extract(runtime_payload_json, '$.modelSelection.instanceId'),
      provider_name
    )
    WHERE provider_instance_id IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_provider_instance
    ON provider_session_runtime(provider_instance_id)
  `;
});
