import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { columnExists } from "./schemaHelpers";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_threads", "parallel_run_json"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parallel_run_json TEXT`;
  }
});
