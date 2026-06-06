import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN workspace_contexts_json TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN active_workspace_context_id TEXT
  `.pipe(Effect.catchTag("SqlError", () => Effect.void));
});
