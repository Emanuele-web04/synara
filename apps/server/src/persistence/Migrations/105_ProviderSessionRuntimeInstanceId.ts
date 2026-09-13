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
    WHERE json_valid(runtime_payload_json)
      AND json_extract(runtime_payload_json, '$.modelSelection.provider') IS NOT NULL
      AND json_extract(runtime_payload_json, '$.modelSelection.instanceId') IS NULL
      AND typeof(json_extract(runtime_payload_json, '$.modelSelection.provider')) = 'text'
      AND length(trim(json_extract(runtime_payload_json, '$.modelSelection.provider'))) BETWEEN 1 AND 64
      AND trim(json_extract(runtime_payload_json, '$.modelSelection.provider')) GLOB '[A-Za-z]*'
      AND trim(json_extract(runtime_payload_json, '$.modelSelection.provider')) NOT GLOB '*[^A-Za-z0-9_-]*'
  `;

  yield* sql`
    UPDATE provider_session_runtime
    SET provider_instance_id = COALESCE(
      CASE
        WHEN json_valid(runtime_payload_json)
          AND typeof(json_extract(runtime_payload_json, '$.providerInstanceId')) = 'text'
          AND length(trim(json_extract(runtime_payload_json, '$.providerInstanceId'))) BETWEEN 1 AND 64
          AND trim(json_extract(runtime_payload_json, '$.providerInstanceId')) GLOB '[A-Za-z]*'
          AND trim(json_extract(runtime_payload_json, '$.providerInstanceId')) NOT GLOB '*[^A-Za-z0-9_-]*'
        THEN trim(json_extract(runtime_payload_json, '$.providerInstanceId'))
      END,
      CASE
        WHEN json_valid(runtime_payload_json)
          AND typeof(json_extract(runtime_payload_json, '$.modelSelection.instanceId')) = 'text'
          AND length(trim(json_extract(runtime_payload_json, '$.modelSelection.instanceId'))) BETWEEN 1 AND 64
          AND trim(json_extract(runtime_payload_json, '$.modelSelection.instanceId')) GLOB '[A-Za-z]*'
          AND trim(json_extract(runtime_payload_json, '$.modelSelection.instanceId')) NOT GLOB '*[^A-Za-z0-9_-]*'
        THEN trim(json_extract(runtime_payload_json, '$.modelSelection.instanceId'))
      END,
      CASE
        WHEN length(trim(provider_name)) BETWEEN 1 AND 64
          AND trim(provider_name) GLOB '[A-Za-z]*'
          AND trim(provider_name) NOT GLOB '*[^A-Za-z0-9_-]*'
        THEN trim(provider_name)
        ELSE 'codex'
      END
    )
    WHERE provider_instance_id IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_provider_instance
    ON provider_session_runtime(provider_instance_id)
  `;
});
