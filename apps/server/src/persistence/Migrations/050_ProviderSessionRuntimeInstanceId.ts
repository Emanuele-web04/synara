import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE provider_session_runtime
    ADD COLUMN provider_instance_id TEXT
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
