import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive: the source message a "Fork from this turn" thread was taken from,
// so the lazy provider fork can stop native history at that turn. Existing
// threads keep NULL (fork from the source's latest point, as before).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "fork_source_message_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN fork_source_message_id TEXT`;
  }
});
