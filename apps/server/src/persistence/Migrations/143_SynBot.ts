// FILE: 143_SynBot.ts
// Purpose: SynBot (Beta) storage: bot profiles on top of Hubs, delegations between bots,
//          and the SynBot settings row. Purely additive, so Stable ignores it safely.
// Layer: Persistence migration

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per bot. The bot itself is the Hub keyed by `project_id`.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_profiles (
      project_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('main', 'bot')),
      role TEXT NOT NULL,
      mascot_shape TEXT NOT NULL,
      mascot_color TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      autonomy TEXT NOT NULL CHECK (autonomy IN ('auto', 'ask')),
      pinned_skills_json TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_profiles_one_main
    ON bot_profiles (kind) WHERE kind = 'main'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_delegations (
      delegation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      depth INTEGER NOT NULL,
      chain_json TEXT NOT NULL,
      from_project_id TEXT NOT NULL,
      from_thread_id TEXT NOT NULL,
      from_turn_id TEXT,
      to_project_id TEXT NOT NULL,
      to_thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      brief TEXT NOT NULL,
      source_messages_json TEXT NOT NULL,
      human_rooted INTEGER NOT NULL,
      state TEXT NOT NULL,
      result_summary TEXT,
      task_ids_json TEXT NOT NULL,
      reported_at TEXT,
      report_message_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      settled_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_delegations_message
    ON bot_delegations (message_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_delegations_target
    ON bot_delegations (to_thread_id, state)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_delegations_report
    ON bot_delegations (report_message_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_delegations_requester
    ON bot_delegations (from_thread_id, from_turn_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_delegations_request
    ON bot_delegations (request_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      fresh_start_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
