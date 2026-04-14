import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`.pipe(
    Effect.catchTag("SqlError", () => Effect.void),
  );
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_agent_id TEXT`.pipe(
    Effect.catchTag("SqlError", () => Effect.void),
  );
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_nickname TEXT`.pipe(
    Effect.catchTag("SqlError", () => Effect.void),
  );
  yield* sql`ALTER TABLE projection_threads ADD COLUMN subagent_role TEXT`.pipe(
    Effect.catchTag("SqlError", () => Effect.void),
  );

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread_id
    ON projection_threads(parent_thread_id)
  `;
});
