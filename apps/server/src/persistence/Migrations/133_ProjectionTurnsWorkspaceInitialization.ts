import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Records that a turn began before its workspace had a Git repository. This is
// intentionally additive so existing projection rows retain the false default.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_turns)`;
  if (!columns.some((column) => column.name === "started_without_git_workspace")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN started_without_git_workspace INTEGER NOT NULL DEFAULT 0
    `;
  }
});
