import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// Additive: a thread can link several pull requests, each with its provenance. The existing
// single `last_known_pr_json` slot becomes one `legacy` link; `last_known_pr_json` itself is kept
// (it stays the derived current PR every older reader uses), so this migration never removes or
// rewrites data. Events are not rewritten either: replay maps a legacy `lastKnownPr` payload to
// the same `legacy` link, and readers fall back to it for any row this backfill did not cover.
// Only `linkedAt` can differ between those paths (backfill: the row's updated_at; replay: the
// event time), which never changes which link is current.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_threads", "pull_requests_json"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pull_requests_json TEXT`;
  }
  yield* sql`
    UPDATE projection_threads
    SET pull_requests_json = json_array(
      json_object(
        'pullRequest', json(last_known_pr_json),
        'source', 'legacy',
        'linkedAt', updated_at
      )
    )
    WHERE pull_requests_json IS NULL
      AND last_known_pr_json IS NOT NULL
      -- json_type() throws on malformed JSON and SQLite does not promise to evaluate AND
      -- operands left to right, so the validity check guards it inside one expression.
      AND CASE
        WHEN json_valid(last_known_pr_json) THEN json_type(last_known_pr_json)
      END = 'object'
  `;
});
