import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

interface CapacityScenario {
  readonly name: string;
  readonly latestTurnId?: string;
  readonly sessionStatus?: "ready" | "error";
  readonly active: boolean;
  readonly turns: ReadonlyArray<{
    readonly id: string | null;
    readonly state: "pending" | "running" | "completed";
    readonly pendingMessageId?: string;
    readonly checkpoint?: number;
  }>;
}

layer("132_ExternalMcpTurnCapacityRecovery", (it) => {
  it.effect("recovers lost terminal pointers without releasing pending or live work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 131 });
      const scenarios: ReadonlyArray<CapacityScenario> = [
        {
          name: "completed-lost-pointer",
          active: false,
          turns: [{ id: "finished", state: "completed" }],
        },
        { name: "ready-before-first-turn", active: true, turns: [] },
        {
          name: "pending-first-turn",
          active: true,
          turns: [{ id: null, state: "pending", pendingMessageId: "pending-message" }],
        },
        {
          name: "pending-after-completed",
          latestTurnId: "finished",
          active: true,
          turns: [
            { id: "finished", state: "completed" },
            { id: null, state: "pending", pendingMessageId: "next-message" },
          ],
        },
        {
          name: "live-turn-session-error",
          sessionStatus: "error",
          active: true,
          turns: [{ id: "live", state: "running" }],
        },
        {
          name: "checkpoint-without-turn",
          active: true,
          turns: [{ id: null, state: "completed", checkpoint: 1 }],
        },
        {
          name: "completed-before-checkpoint",
          active: false,
          turns: [
            { id: "finished", state: "completed" },
            { id: null, state: "completed", checkpoint: 1 },
          ],
        },
        {
          name: "older-orphaned-live-turn",
          latestTurnId: "finished",
          active: false,
          turns: [
            { id: "live", state: "running" },
            { id: "finished", state: "completed" },
          ],
        },
        {
          name: "older-orphaned-pending-turn",
          latestTurnId: "finished",
          active: false,
          turns: [
            { id: null, state: "pending", pendingMessageId: "old-message" },
            { id: "finished", state: "completed" },
          ],
        },
        {
          name: "failed-provider-start-pending-turn",
          sessionStatus: "error",
          active: false,
          turns: [{ id: null, state: "pending", pendingMessageId: "failed-message" }],
        },
      ];
      yield* sql`
        INSERT INTO external_mcp_integrations (
          integration_id, name, client_kind, audience, capabilities_json,
          created_at, expires_at, rate_limit_per_minute, concurrency_limit
        ) VALUES (
          'capacity-recovery', 'Capacity recovery', 'other', 'synara.external-mcp',
          '[]', '2026-10-09T00:00:00.000Z', '2027-10-09T00:00:00.000Z', 60, 2
        )
      `;
      for (const scenario of scenarios) {
        yield* sql`
          INSERT INTO external_mcp_operations (
            operation_id, integration_id, request_id, fingerprint, requested_count,
            plan_json, status, created_at, updated_at
          ) VALUES (
            ${scenario.name}, 'capacity-recovery', ${scenario.name}, ${scenario.name}, 1,
            '[]', 'completed', '2026-10-09T00:00:00.000Z', '2026-10-09T00:01:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO external_mcp_tasks (
            integration_id, operation_id, request_id, thread_id, project_id,
            status, created_at, updated_at
          ) VALUES (
            'capacity-recovery', ${scenario.name}, ${scenario.name}, ${scenario.name},
            'capacity-project', 'created', '2026-10-09T00:00:00.000Z', '2026-10-09T00:01:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, latest_turn_id,
            created_at, updated_at
          ) VALUES (
            ${scenario.name}, 'capacity-project', ${scenario.name},
            '{"provider":"codex","model":"gpt-5-codex"}', ${scenario.latestTurnId ?? null},
            '2026-10-09T00:00:00.000Z', '2026-10-09T00:01:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, active_turn_id, updated_at
          ) VALUES (
            ${scenario.name}, ${scenario.sessionStatus ?? "ready"}, 'codex', NULL,
            '2026-10-09T00:01:00.000Z'
          )
        `;
        for (const [index, turn] of scenario.turns.entries()) {
          yield* sql`
            INSERT INTO projection_turns (
              thread_id, turn_id, pending_message_id, state, requested_at,
              completed_at, checkpoint_turn_count, checkpoint_files_json
            ) VALUES (
              ${scenario.name}, ${turn.id}, ${turn.pendingMessageId ?? null}, ${turn.state},
              ${`2026-10-09T00:00:0${index}.000Z`},
              ${turn.state === "completed" ? "2026-10-09T00:00:30.000Z" : null},
              ${turn.checkpoint ?? null}, '[]'
            )
          `;
        }
      }
      const activeOperations = () => sql<{ readonly operationId: string }>`
        SELECT operation_id AS "operationId" FROM external_mcp_active_capacity_claims
        WHERE integration_id = 'capacity-recovery' ORDER BY operation_id
      `;
      assert.isTrue(
        (yield* activeOperations()).some((row) => row.operationId === "completed-lost-pointer"),
      );
      yield* runMigrations({ toMigrationInclusive: 132 });
      const expected = scenarios
        .filter((scenario) => scenario.active)
        .map((scenario) => ({ operationId: scenario.name }))
        .toSorted((left, right) => left.operationId.localeCompare(right.operationId));
      assert.deepEqual(yield* activeOperations(), expected);
      // A restart uses the already-migrated view and must not reintroduce a claim.
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 132 }), []);
      assert.deepEqual(yield* activeOperations(), expected);
    }),
  );
});
