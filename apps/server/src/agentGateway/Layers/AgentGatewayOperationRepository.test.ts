import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { notifyAfterCommit } from "../../persistence/commitNotifications.ts";
import { AgentGatewayOperationRepository } from "../Services/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepositoryLive } from "./AgentGatewayOperationRepository.ts";

const layer = it.layer(
  Layer.merge(AgentGatewayOperationRepositoryLive, ProjectAgentRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
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
  it.effect("commits worker tracking and operation results atomically", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const groups = yield* ProjectAgentRepository;
      const sql = yield* SqlClient.SqlClient;
      const scoped = {
        ...base,
        callerTurnId: "turn-group-commit",
        operationId: "group-commit",
        planJson: JSON.stringify([
          {
            notifyCreatorOnComplete: true,
            ids: { threadId: "group-commit-child", messageId: "group-commit-message" },
          },
        ]),
      };
      yield* repository.reserve(scoped);
      yield* repository.markDispatching({ operationId: scoped.operationId, now: scoped.now });
      const projectId = ProjectId.makeUnsafe("group-commit-project");
      const track = groups.upsertThreadIndex({
        projectId,
        threadId: ThreadId.makeUnsafe("group-commit-child"),
        excluded: false,
        archived: false,
        summaryStatus: "pending",
        lastUpdatedAt: scoped.now,
        lastSummarizedAt: null,
      });
      const complete = {
        operationId: scoped.operationId,
        resultJson: '{"threadIds":["group-commit-child"]}',
        now: scoped.now,
      };
      const failedTracking = yield* repository
        .complete(
          complete,
          track.pipe(Effect.andThen(Effect.fail(new Error("partial tracking failure")))),
        )
        .pipe(Effect.result);
      assert.equal(failedTracking._tag, "Failure");
      assert.equal((yield* repository.getById(scoped.operationId))?.status, "dispatching");
      assert.deepEqual(yield* groups.listThreadIndex(projectId), []);
      yield* sql`CREATE TRIGGER reject_group_commit BEFORE UPDATE OF status ON agent_gateway_operations WHEN NEW.operation_id = 'group-commit' AND NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'commit failure'); END`;
      const failedCommit = yield* repository.complete(complete, track).pipe(Effect.result);
      assert.equal(failedCommit._tag, "Failure");
      assert.equal((yield* repository.getById(scoped.operationId))?.status, "dispatching");
      assert.deepEqual(yield* groups.listThreadIndex(projectId), []);
      assert.deepEqual(
        yield* sql`SELECT * FROM agent_gateway_completions WHERE child_thread_id = 'group-commit-child'`,
        [],
      );
      yield* sql`DROP TRIGGER reject_group_commit`;
      yield* repository.complete(complete, track);
      assert.equal((yield* repository.getById(scoped.operationId))?.status, "completed");
      assert.equal((yield* groups.listThreadIndex(projectId)).length, 1);
    }),
  );

  it.effect("preserves a committed create when post-commit notifications die or interrupt", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const groups = yield* ProjectAgentRepository;
      const projectId = ProjectId.makeUnsafe("post-commit-project");
      const delivered: string[] = [];
      for (const [index, notification] of [
        Effect.die("publish failed"),
        Effect.interrupt,
      ].entries()) {
        const operationId = `post-commit-${index}`;
        const threadId = ThreadId.makeUnsafe(`post-commit-child-${index}`);
        yield* repository.reserve({
          ...base,
          operationId,
          callerTurnId: `post-commit-turn-${index}`,
        });
        yield* repository.markDispatching({ operationId, now: base.now });
        const resultJson = JSON.stringify({ threadIds: [threadId] });
        const completed = yield* repository
          .complete(
            { operationId, resultJson, now: base.now },
            groups
              .upsertThreadIndex({
                projectId,
                threadId,
                excluded: false,
                archived: false,
                summaryStatus: "pending",
                lastUpdatedAt: base.now,
                lastSummarizedAt: null,
              })
              .pipe(
                Effect.andThen(notifyAfterCommit(notification)),
                Effect.andThen(
                  notifyAfterCommit(
                    Effect.sync(() => {
                      delivered.push(operationId);
                    }),
                  ),
                ),
              ),
          )
          .pipe(Effect.exit);
        assert.equal(completed._tag, "Success");
        const persisted = yield* repository.getById(operationId);
        assert.equal(persisted?.status, "completed");
        assert.equal(persisted?.resultJson, resultJson);
        assert.equal(
          (yield* groups.listThreadIndex(projectId)).some((entry) => entry.threadId === threadId),
          true,
        );
      }
      assert.deepEqual(delivered, ["post-commit-0", "post-commit-1"]);
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
          token: "owner-token",
          gitDir: "/repo/.git/worktrees/owned",
          head: "0123456789abcdef",
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
          token: "owner-token",
          gitDir: "/repo/.git/worktrees/owned",
          head: "0123456789abcdef",
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
          token: "owner-token",
          gitDir: "/repo/.git/worktrees/owned",
          head: "0123456789abcdef",
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

  it.effect("retains sanitized caller-purged operations while compensation is retryable", () =>
    Effect.gen(function* () {
      const repository = yield* AgentGatewayOperationRepository;
      const sql = yield* SqlClient.SqlClient;
      const scoped = {
        ...base,
        callerTurnId: "turn-purged-retry",
        operationId: "operation-purged-retry",
      };
      yield* repository.reserve(scoped);
      yield* repository.markDispatching({ operationId: scoped.operationId, now: scoped.now });
      yield* sql`
        UPDATE agent_gateway_operations
        SET caller_purged_at = '2026-07-16T00:00:01.000Z'
        WHERE operation_id = ${scoped.operationId}
      `;
      yield* repository.recordCompensationFailure({
        operationId: scoped.operationId,
        errorJson: '{"code":"cleanup_pending","path":"/private/worktree"}',
        now: "2026-07-16T00:00:02.000Z",
      });

      const stored = yield* repository.getById(scoped.operationId);
      assert.equal(stored?.status, "compensating");
      assert.equal(stored?.errorJson, '{"code":"cleanup_pending"}');
      assert.notInclude(stored?.errorJson ?? "", "/private/worktree");
      assert.isTrue(
        (yield* repository.listNonTerminal()).some(
          (operation) => operation.operationId === scoped.operationId,
        ),
      );
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
