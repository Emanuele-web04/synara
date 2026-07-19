import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AgentGatewayOperationRepository } from "../Services/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepositoryLive } from "./AgentGatewayOperationRepository.ts";

const layer = it.layer(
  AgentGatewayOperationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const base = {
  operationId: "operation-1",
  callerThreadId: "caller-1",
  callerTurnId: "turn-1",
  operationKind: "create_threads" as const,
  requestId: "request-1",
  fingerprint: "fingerprint-1",
  requestedCount: 2,
  planJson: '{"threads":["one","two"]}',
  now: "2026-07-16T00:00:00.000Z",
};

layer("AgentGatewayOperationRepository", (it) => {
  it.effect("reserves once and replays the same operation", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      assert.equal((yield* repository.reserve(base)).kind, "reserved");
      assert.equal(
        (yield* repository.reserve({ ...base, now: "2026-07-16T00:00:01.000Z" })).kind,
        "replay",
      );
    }),
  );

  it.effect("distinguishes request conflicts from a second plan in the same turn", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const scoped = { ...base, callerTurnId: "turn-2", operationId: "operation-2" };
      yield* repository.reserve(scoped);

      assert.equal(
        (yield* repository.reserve({
          ...scoped,
          operationId: "operation-2-conflict",
          fingerprint: "different",
        })).kind,
        "idempotency_conflict",
      );
      assert.equal(
        (yield* repository.reserve({
          ...scoped,
          operationId: "operation-2-locked",
          requestId: "request-2",
          fingerprint: "different",
        })).kind,
        "creation_plan_locked",
      );
    }),
  );

  it.effect("persists completion results for restart-safe replay", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const scoped = { ...base, callerTurnId: "turn-3", operationId: "operation-3" };
      yield* repository.reserve(scoped);
      yield* repository.markDispatching({ operationId: scoped.operationId, now: scoped.now });
      yield* repository.complete({
        operationId: scoped.operationId,
        resultJson: '{"threadIds":["a","b"]}',
        now: "2026-07-16T00:00:02.000Z",
      });

      const stored = yield* repository.getById(scoped.operationId);
      assert.equal(stored?.status, "completed");
      assert.equal(stored?.resultJson, '{"threadIds":["a","b"]}');
    }),
  );

  it.effect("keeps interrupted operations visible for deterministic startup compensation", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const scoped = { ...base, callerTurnId: "turn-4", operationId: "operation-4" };
      yield* repository.reserve(scoped);
      yield* repository.markDispatching({ operationId: scoped.operationId, now: scoped.now });

      assert.isTrue(
        (yield* repository.listNonTerminal()).some(
          (operation) => operation.operationId === scoped.operationId,
        ),
      );
      yield* repository.markCompensating({
        operationId: scoped.operationId,
        now: "2026-07-16T00:00:03.000Z",
      });
      assert.equal((yield* repository.getById(scoped.operationId))?.status, "compensating");
    }),
  );

  it.effect("records worktree ownership only after a dispatching operation created it", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const scoped = {
        ...base,
        callerTurnId: "turn-worktree",
        operationId: "operation-worktree",
        requestedCount: 1,
        planJson: JSON.stringify([
          {
            workspaceRoot: "/repo",
            environment: "worktree",
            newBranch: "agent/owned",
            plannedWorktreePath: "/worktrees/owned",
            ownershipPreflightPassed: true,
            ids: { threadId: "child-owned", compensateCommandId: "delete-child-owned" },
          },
        ]),
      };
      yield* repository.reserve(scoped);
      assert.isFalse(
        yield* repository.recordWorktreeCreated({
          operationId: scoped.operationId,
          index: 0,
          workspaceRoot: "/repo",
          path: "/worktrees/owned",
          branch: "agent/owned",
          now: scoped.now,
        }),
      );
      yield* repository.markDispatching({ operationId: scoped.operationId, now: scoped.now });
      assert.isTrue(
        yield* repository.recordWorktreeCreated({
          operationId: scoped.operationId,
          index: 0,
          workspaceRoot: "/repo",
          path: "/worktrees/owned",
          branch: "agent/owned",
          now: "2026-07-16T00:00:01.000Z",
        }),
      );
      expect(
        JSON.parse((yield* repository.getById(scoped.operationId))!.planJson)[0],
      ).toMatchObject({
        worktreeOwnership: {
          operationId: scoped.operationId,
          path: "/worktrees/owned",
          branch: "agent/owned",
        },
      });
    }),
  );

  it.effect("deletes a caller-purged live operation as soon as it terminalizes", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const sql = yield* SqlClient.SqlClient;
      const scoped = { ...base, callerTurnId: "turn-purged", operationId: "operation-purged" };
      yield* repository.reserve(scoped);
      yield* repository.markDispatching({ operationId: scoped.operationId, now: scoped.now });
      yield* sql`
        UPDATE agent_gateway_operations
        SET caller_purged_at = '2026-07-16T00:00:01.000Z'
        WHERE operation_id = ${scoped.operationId}
      `;
      yield* repository.fail({
        operationId: scoped.operationId,
        errorJson: '{"code":"recovered"}',
        now: "2026-07-16T00:00:02.000Z",
      });
      assert.isNull(yield* repository.getById(scoped.operationId));
    }),
  );

  it.effect("serializes concurrent reservation and dispatch claims", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const scoped = { ...base, callerTurnId: "turn-5", operationId: "operation-5" };
      const reservations = yield* Effect.all(
        [repository.reserve(scoped), repository.reserve(scoped)],
        { concurrency: "unbounded" },
      );
      assert.sameMembers(
        reservations.map((reservation) => reservation.kind),
        ["reserved", "replay"],
      );
      const claims = yield* Effect.all(
        [
          repository.markDispatching({ operationId: scoped.operationId, now: scoped.now }),
          repository.markDispatching({ operationId: scoped.operationId, now: scoped.now }),
        ],
        { concurrency: "unbounded" },
      );
      assert.sameMembers(claims, [true, false]);
      assert.equal(
        (yield* repository.listNonTerminal()).filter(
          (operation) => operation.callerTurnId === scoped.callerTurnId,
        ).length,
        1,
      );
    }),
  );
});
