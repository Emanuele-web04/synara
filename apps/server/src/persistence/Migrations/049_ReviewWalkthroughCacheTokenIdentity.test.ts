import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const walkthroughRows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly repositoryId: string;
    readonly reference: string;
    readonly patchSignature: string;
    readonly tokenIdentity: string;
    readonly payloadJson: string;
    readonly fetchedAt: number;
  }>`
    SELECT
      repository_id AS "repositoryId",
      reference,
      patch_signature AS "patchSignature",
      token_identity AS "tokenIdentity",
      payload_json AS "payloadJson",
      fetched_at AS "fetchedAt"
    FROM review_cache_pr_walkthrough
    ORDER BY repository_id, reference, patch_signature, token_identity
  `;

layer("049_ReviewWalkthroughCacheTokenIdentity", (it) => {
  it.effect("preserves existing walkthrough rows when adding token identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO review_cache_pr_walkthrough (
          repository_id,
          reference,
          patch_signature,
          payload_json,
          fetched_at
        )
        VALUES (
          'repo-1',
          '42',
          'patch-1',
          '{"chapters":[]}',
          123
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 58 });

      assert.deepStrictEqual(yield* walkthroughRows(sql), [
        {
          repositoryId: "repo-1",
          reference: "42",
          patchSignature: "patch-1",
          tokenIdentity: "gh-user-v2:unknown",
          payloadJson: '{"chapters":[]}',
          fetchedAt: 123,
        },
      ]);
    }),
  );

  it.effect("keeps walkthrough rows stable through the forward repair migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`
        INSERT INTO review_cache_pr_walkthrough (
          repository_id,
          reference,
          patch_signature,
          token_identity,
          payload_json,
          fetched_at
        )
        VALUES (
          'repo-1',
          '42',
          'patch-1',
          'gh-user-v2:tyler',
          '{"chapters":[]}',
          123
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 59 });

      assert.deepStrictEqual(yield* walkthroughRows(sql), [
        {
          repositoryId: "repo-1",
          reference: "42",
          patchSignature: "patch-1",
          tokenIdentity: "gh-user-v2:tyler",
          payloadJson: '{"chapters":[]}',
          fetchedAt: 123,
        },
      ]);
    }),
  );
});
