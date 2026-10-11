import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "provider_instance_id")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_instance_id = COALESCE(
      (
        SELECT CASE
          WHEN typeof(json_extract(provider_session_runtime.runtime_payload_json, '$.providerInstanceId')) = 'text'
            AND length(trim(json_extract(provider_session_runtime.runtime_payload_json, '$.providerInstanceId'))) BETWEEN 1 AND 64
            AND trim(json_extract(provider_session_runtime.runtime_payload_json, '$.providerInstanceId')) GLOB '[A-Za-z]*'
            AND trim(json_extract(provider_session_runtime.runtime_payload_json, '$.providerInstanceId')) NOT GLOB '*[^A-Za-z0-9_-]*'
          THEN trim(json_extract(provider_session_runtime.runtime_payload_json, '$.providerInstanceId'))
        END
        FROM provider_session_runtime
        WHERE provider_session_runtime.thread_id = projection_thread_sessions.thread_id
          AND json_valid(provider_session_runtime.runtime_payload_json)
      ),
      (
        SELECT CASE
          WHEN typeof(json_extract(provider_session_runtime.runtime_payload_json, '$.modelSelection.instanceId')) = 'text'
            AND length(trim(json_extract(provider_session_runtime.runtime_payload_json, '$.modelSelection.instanceId'))) BETWEEN 1 AND 64
            AND trim(json_extract(provider_session_runtime.runtime_payload_json, '$.modelSelection.instanceId')) GLOB '[A-Za-z]*'
            AND trim(json_extract(provider_session_runtime.runtime_payload_json, '$.modelSelection.instanceId')) NOT GLOB '*[^A-Za-z0-9_-]*'
          THEN trim(json_extract(provider_session_runtime.runtime_payload_json, '$.modelSelection.instanceId'))
        END
        FROM provider_session_runtime
        WHERE provider_session_runtime.thread_id = projection_thread_sessions.thread_id
          AND json_valid(provider_session_runtime.runtime_payload_json)
      ),
      (
        SELECT CASE
          WHEN typeof(json_extract(projection_threads.model_selection_json, '$.instanceId')) = 'text'
            AND length(trim(json_extract(projection_threads.model_selection_json, '$.instanceId'))) BETWEEN 1 AND 64
            AND trim(json_extract(projection_threads.model_selection_json, '$.instanceId')) GLOB '[A-Za-z]*'
            AND trim(json_extract(projection_threads.model_selection_json, '$.instanceId')) NOT GLOB '*[^A-Za-z0-9_-]*'
          THEN trim(json_extract(projection_threads.model_selection_json, '$.instanceId'))
        END
        FROM projection_threads
        WHERE projection_threads.thread_id = projection_thread_sessions.thread_id
          AND json_valid(projection_threads.model_selection_json)
      ),
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
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_provider_instance
    ON projection_thread_sessions(provider_instance_id)
  `;
});
