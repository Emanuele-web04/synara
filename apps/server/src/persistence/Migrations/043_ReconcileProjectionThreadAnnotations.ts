import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "pinned_messages_json"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pinned_messages_json TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "notes"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN notes TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_threads", "thread_markers_json"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN thread_markers_json TEXT
    `;
  }

  if (!(yield* columnExists(sql, "projection_projects", "is_pinned"))) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
    `;
  }
});
