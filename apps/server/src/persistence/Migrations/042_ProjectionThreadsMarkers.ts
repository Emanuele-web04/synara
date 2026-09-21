/** thread_markers_json: highlight/underline ranges from transcript selections */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "thread_markers_json"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN thread_markers_json TEXT
    `;
  }
});
