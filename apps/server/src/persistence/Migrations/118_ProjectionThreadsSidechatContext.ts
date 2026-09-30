import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

/**
 * Standalone sidechats (asked about a GitHub item, with no source thread) store what they are
 * about. Additive and nullable: every existing thread reads back as `null`, and a Stable build
 * that never writes the column ignores it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "sidechat_context_json"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sidechat_context_json TEXT
    `;
  }
});
