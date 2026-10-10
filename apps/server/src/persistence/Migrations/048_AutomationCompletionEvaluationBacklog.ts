import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Backs the pending stop-check scan, which reads oldest succeeded runs first.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_completion_eval
    ON automation_runs (finished_at, run_id)
    WHERE status = 'succeeded' AND finished_at IS NOT NULL
  `;

  yield* sql`
    CREATE VIEW IF NOT EXISTS automation_pending_completion_evaluations AS
    SELECT
      runs.run_id,
      runs.automation_id,
      runs.thread_id,
      runs.finished_at
    FROM automation_runs runs
    INNER JOIN automation_definitions definitions
      ON definitions.automation_id = runs.automation_id
    WHERE runs.status = 'succeeded'
      AND definitions.enabled = 1
      AND definitions.archived_at IS NULL
      AND definitions.mode = 'heartbeat'
      AND json_extract(definitions.completion_policy_json, '$.type') = 'ai-evaluated'
      AND runs.finished_at IS NOT NULL
      AND (
        json_extract(runs.permission_snapshot_json, '$.completionPolicyVersion') =
          definitions.completion_policy_version
        OR (
          json_type(runs.permission_snapshot_json, '$.completionPolicyVersion') IS NULL
          AND COALESCE(runs.started_at, runs.created_at) >
            COALESCE(
              definitions.completion_policy_updated_at,
              definitions.updated_at,
              definitions.created_at,
              '1970-01-01T00:00:00.000Z'
            )
        )
      )
      AND (
        runs.result_json IS NULL
        OR json_type(runs.result_json, '$.completionEvaluation') IS NULL
      )
  `;
});
