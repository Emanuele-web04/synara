// FILE: 081_AutomationProposals.ts
// Purpose: Adds the additive proposal lifecycle for agent-suggested automations.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "proposal_state"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN proposal_state TEXT
      CHECK (proposal_state IS NULL OR proposal_state IN ('pending', 'accepted', 'dismissed'))
    `;
  }
});
