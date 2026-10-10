// Purpose: Drops two orchestration_events indexes that migration 001 created but that no
//          query has ever used. `command_id` and `correlation_id` appear only in INSERT
//          column lists and SELECT projections; every read filters, joins, or orders by
//          `sequence`, `event_type`, `aggregate_kind`, or `stream_id` instead. The only
//          `WHERE command_id = ...` clauses in the codebase target the unrelated
//          `git_handoff_operations` table.
//
//          They were not free: on a mature database they cost ~43 MiB each and were
//          maintained on every event append, which is the hottest write path in Synara.
//
//          Forward-only and re-runnable. `001_OrchestrationEvents.ts` is left untouched so
//          migration lineage stays intact; a fresh database creates the indexes there and
//          drops them here.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_orch_events_command_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
});
