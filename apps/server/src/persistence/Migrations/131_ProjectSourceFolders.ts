import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive: extra source folders of a multi-folder project, as a JSON array of
// absolute paths. Existing projects keep `[]` and stay single-folder.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
  if (!columns.some((column) => column.name === "additional_folders_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN additional_folders_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
