import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_threads", "snoozed_until"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN snoozed_until TEXT`;
  }
  if (!(yield* columnExists(sql, "projection_threads", "snooze_reminder_at"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN snooze_reminder_at TEXT`;
  }
});
