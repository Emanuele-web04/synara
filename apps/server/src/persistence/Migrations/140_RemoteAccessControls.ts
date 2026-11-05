import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers";

/** Owner "Allow connections" switch and per-device enrolment metadata. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "remote_access_state", "allow_connections"))) {
    yield* sql`ALTER TABLE remote_access_state ADD COLUMN allow_connections INTEGER NOT NULL DEFAULT 1`;
  }
  if (!(yield* columnExists(sql, "remote_device_trust", "enrolled_via"))) {
    yield* sql`ALTER TABLE remote_device_trust ADD COLUMN enrolled_via TEXT NOT NULL DEFAULT 'approval'`;
  }
  if (!(yield* columnExists(sql, "remote_device_trust", "last_connected_at"))) {
    yield* sql`ALTER TABLE remote_device_trust ADD COLUMN last_connected_at TEXT`;
  }
});
