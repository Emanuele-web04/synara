import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN provider_instance_id TEXT
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_instance_id = provider_name
    WHERE provider_instance_id IS NULL
  `;
});
