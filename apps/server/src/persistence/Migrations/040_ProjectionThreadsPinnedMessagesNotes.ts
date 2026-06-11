/**
 * Adds durable per-thread workspace annotations to projected threads:
 * `pinned_messages_json` holds the sidebar checklist of pinned assistant
 * messages, and `notes` holds the freeform scratchpad. Both are server-owned
 * so they survive restarts/reconnects and sync across clients.
 */
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
});
