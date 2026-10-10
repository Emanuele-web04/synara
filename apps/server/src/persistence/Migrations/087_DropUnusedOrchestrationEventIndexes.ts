// drops two indexes migration 001 created but no query uses — ~43 MiB each maintained on every append, the hottest write path; forward-only and re-runnable; 001 left untouched so lineage stays intact

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_orch_events_command_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
});
