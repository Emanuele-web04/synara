import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers";

/** Existing credentials keep unknown provenance; only new issuance records an origin. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "auth_pairing_links", "access_origin"))) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN access_origin TEXT
      CHECK (access_origin IS NULL OR access_origin IN ('local', 'remote'))`;
  }
  if (!(yield* columnExists(sql, "auth_sessions", "access_origin"))) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN access_origin TEXT
      CHECK (access_origin IS NULL OR access_origin IN ('local', 'remote'))`;
  }
});
