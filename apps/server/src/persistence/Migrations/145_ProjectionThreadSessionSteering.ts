// Stores capability negotiated for the active provider session. Existing sessions default to unknown.
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_thread_sessions", "supports_native_turn_steering"))) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN supports_native_turn_steering INTEGER
      CHECK (supports_native_turn_steering IN (0, 1))
    `;
  }
});
