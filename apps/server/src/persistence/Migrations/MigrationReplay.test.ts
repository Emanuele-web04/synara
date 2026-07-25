// FILE: MigrationReplay.test.ts
// Purpose: Proves the replayed migration range is re-runnable against its own post-state.
// Layer: SQLite migration test

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

/**
 * A released migration id was renumbered once (54 shipped as
 * `ProjectPullRequestPins`, then became `DurableProviderCommandDelivery`).
 * Lineage reconciliation answers a divergence by forgetting every tracker row
 * from that point onward, which makes the migrator replay the range over a
 * schema that already contains it — migration 56 died on
 * `duplicate column name: fingerprint_version` and the backend never booted.
 *
 * These tests reproduce that post-reconcile state directly, by tracker rows
 * rather than through `Migrations.ts`, so they keep asserting the property the
 * migrations themselves own — every migration at or after this id survives
 * being applied a second time — independently of how reconciliation decides to
 * classify any particular lineage.
 */
const REPLAY_FROM_MIGRATION_ID = 54;

const replayedEntries = migrationEntries
  .filter(([id]) => id >= REPLAY_FROM_MIGRATION_ID)
  // `migrationEntries` is `as const`, so an unannotated map widens each pair into an array of
  // the literal union rather than a tuple. Name the tuple so the comparison stays typed.
  .map(([id, name]): readonly [id: number, name: string] => [id, name]);

const schemaObjects = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
  }>`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;

/** Reproduces exactly what a lineage reconciliation leaves behind. */
const forgetMigrationsFromReplayPoint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${REPLAY_FROM_MIGRATION_ID}`;
});

/** Durable rows owned by tables the replayed range rebuilds, drops, or backfills. */
const seedDurableState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'replay-project', 'project', 'Replay', '/workspace/replay', '[]',
      '2026-07-24T10:00:00.000Z', '2026-07-24T10:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, created_at, updated_at,
      runtime_mode, interaction_mode, env_mode
    ) VALUES (
      'replay-thread', 'replay-project', 'Replay thread',
      '2026-07-24T10:00:00.000Z', '2026-07-24T10:00:00.000Z',
      'full-access', 'default', 'local'
    )
  `;
  // A sequence with no surviving orchestration event: a replayed backfill must
  // not reset it to NULL.
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, role, text, is_streaming, sequence, created_at, updated_at
    ) VALUES (
      'replay-message', 'replay-thread', 'user', 'hello', 0, 4242,
      '2026-07-24T10:00:01.000Z', '2026-07-24T10:00:01.000Z'
    )
  `;
  // Only representable after migration 62 consolidated approvals and user input.
  yield* sql`
    INSERT INTO projection_pending_interactions (
      interaction_kind, request_id, thread_id, status, created_at
    ) VALUES (
      'userInput', 'replay-request', 'replay-thread', 'pending', '2026-07-24T10:00:02.000Z'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status,
      fingerprint_version, command_fingerprint
    ) VALUES (
      'replay-command', 'thread', 'replay-thread', '2026-07-24T10:00:03.000Z', 1, 'accepted',
      1, 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    )
  `;
});

const schemaLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

schemaLayer("migration replay schema stability", (it) => {
  it.effect("replays the reconciled range without error or schema drift", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedDurableState;
      const schemaBefore = yield* schemaObjects(sql);

      yield* forgetMigrationsFromReplayPoint;
      const replayed = yield* runMigrations();

      assert.deepStrictEqual(replayed, replayedEntries);
      assert.deepStrictEqual(yield* schemaObjects(sql), schemaBefore);
    }),
  );
});

const dataLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

dataLayer("migration replay data preservation", (it) => {
  it.effect("preserves durable rows the replayed range would otherwise rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedDurableState;

      yield* forgetMigrationsFromReplayPoint;
      yield* runMigrations();

      const messages = yield* sql<{
        readonly messageId: string;
        readonly text: string;
        readonly sequence: number | null;
      }>`
        SELECT message_id AS "messageId", text, sequence
        FROM projection_thread_messages
        WHERE thread_id = 'replay-thread'
      `;
      assert.deepStrictEqual(messages, [
        { messageId: "replay-message", text: "hello", sequence: 4242 },
      ]);

      const interactions = yield* sql<{
        readonly interactionKind: string;
        readonly requestId: string;
        readonly status: string;
      }>`
        SELECT interaction_kind AS "interactionKind", request_id AS "requestId", status
        FROM projection_pending_interactions
        WHERE thread_id = 'replay-thread'
      `;
      assert.deepStrictEqual(interactions, [
        { interactionKind: "userInput", requestId: "replay-request", status: "pending" },
      ]);

      const receipts = yield* sql<{
        readonly commandId: string;
        readonly fingerprintVersion: number | null;
      }>`
        SELECT command_id AS "commandId", fingerprint_version AS "fingerprintVersion"
        FROM orchestration_command_receipts
      `;
      assert.deepStrictEqual(receipts, [{ commandId: "replay-command", fingerprintVersion: 1 }]);

      const retiredApprovals = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_pending_approvals'
      `;
      assert.strictEqual(retiredApprovals[0]?.count, 0);
    }),
  );
});

const repeatedLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

repeatedLayer("migration replay repeatability", (it) => {
  it.effect("stays re-runnable across repeated reconciliations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedDurableState;

      yield* forgetMigrationsFromReplayPoint;
      yield* runMigrations();
      const schemaAfterFirstReplay = yield* schemaObjects(sql);

      yield* forgetMigrationsFromReplayPoint;
      const secondReplay = yield* runMigrations();

      assert.deepStrictEqual(secondReplay, replayedEntries);
      assert.deepStrictEqual(yield* schemaObjects(sql), schemaAfterFirstReplay);
    }),
  );
});
