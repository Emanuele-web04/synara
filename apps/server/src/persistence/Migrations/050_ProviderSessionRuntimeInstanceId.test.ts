// FILE: 050_ProviderSessionRuntimeInstanceId.test.ts
// Purpose: Verifies legacy runtime payload model selections are canonicalized to
//          the instance-id shape and provider_instance_id is backfilled.
// Layer: Persistence migration test

import { ModelSelection } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const isModelSelection = Schema.is(ModelSelection);

layer("050_ProviderSessionRuntimeInstanceId", (it) => {
  it.effect("canonicalizes legacy modelSelection payloads and backfills instance ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-07-02T20:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 49 });

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          'thread-legacy-selection',
          'codex',
          'codex',
          'full-access',
          'stopped',
          ${now},
          NULL,
          ${JSON.stringify({
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          })}
        )
      `;

      yield* runMigrations();

      const rows = yield* sql<{
        readonly provider_instance_id: string | null;
        readonly runtime_payload_json: string | null;
      }>`
        SELECT provider_instance_id, runtime_payload_json
        FROM provider_session_runtime
        WHERE thread_id = 'thread-legacy-selection'
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.provider_instance_id, "codex");

      const payload = JSON.parse(rows[0]?.runtime_payload_json ?? "{}") as {
        modelSelection?: Record<string, unknown>;
      };
      assert.equal(payload.modelSelection?.instanceId, "codex");
      assert.equal(payload.modelSelection?.provider, undefined);
      assert.equal(payload.modelSelection?.model, "gpt-5.4");
      // Recovery gates on the strict schema; the canonicalized payload must decode.
      assert.equal(isModelSelection(payload.modelSelection), true);
    }),
  );
});
