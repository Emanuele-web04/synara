import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "remote_host_trust", "desired"))) {
    yield* sql`ALTER TABLE remote_host_trust ADD COLUMN desired INTEGER NOT NULL DEFAULT 0`;
  }
});
