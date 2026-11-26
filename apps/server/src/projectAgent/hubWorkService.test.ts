import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { stableGatewayDigest } from "../agentGateway/creationUtils";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages";
import { ProjectAgentServiceError } from "./Errors";
import { HubWorkRepositoryLive } from "../persistence/Layers/HubWorkRepository";
import { ProjectAgentRepositoryLive } from "../persistence/Layers/ProjectAgentRepository";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { HubWorkRepository } from "../persistence/Services/HubWorkRepository";
import { ProjectAgentRepository } from "../persistence/Services/ProjectAgentRepository";
import { makeHubWorkService } from "./hubWorkService";

const tests = it.layer(
  Layer.mergeAll(
    HubWorkRepositoryLive,
    ProjectAgentRepositoryLive,
    OrchestrationCommandReceiptRepositoryLive,
    ProjectionThreadMessageRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const now = "2026-10-02T10:00:00.000Z";
function harness(name: string) {
  return Effect.gen(function* () {
    const repository = yield* HubWorkRepository;
    const commandReceipts = yield* OrchestrationCommandReceiptRepository;
    const messages = yield* ProjectionThreadMessageRepository;
    const projectAgentRepository = yield* ProjectAgentRepository;
    const projectId = ProjectId.makeUnsafe(name);
    const coordinator = ThreadId.makeUnsafe(`${name}:coordinator`);
    const workerId = ThreadId.makeUnsafe(`${name}:worker`);
    yield* projectAgentRepository.saveConfig(
      {
        projectId,
        coordinatorThreadId: coordinator,
        coordinatorName: "Hub",
        coordinatorModelSelection: { provider: "codex", model: "fixture" },
        limits: {
          maxConcurrentWorkers: 1,
          maxNewWorkersPerTurn: 8,
          maxWorkerCreationsPerGoal: 40,
          maxAutomaticContinuationsPerGoal: 20,
          maxRepairRoundsPerTask: 2,
        },
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        pausedAt: null,
        archivedAt: null,
      },
      null,
    );
    const sourceMessages = [1, 2].map((index) => ({
      threadId: coordinator,
      messageId: MessageId.makeUnsafe(`${name}:source:${index}`),
      turnId: TurnId.makeUnsafe(`${name}:turn`),
      text: `Original ${index}`,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    }));
    let shells: OrchestrationThreadShell[] = [];
    let pending: string[] = [];
    let notificationsFail = false;
    const dependencies = {
      repository,
      projectAgentRepository,
      projectAgentService: {
        resolvePrincipalForThread: (threadId) =>
          Effect.succeed(
            threadId === coordinator
              ? { kind: "coordinator", threadId, projectId }
              : { kind: "worker", threadId, projectId, taskId: null },
          ),
        assertCallerMayCreateThreadInProject: () => Effect.void,
        notifyWorkItemChanged: () =>
          Effect.suspend(() =>
            notificationsFail
              ? Effect.fail(new ProjectAgentServiceError({ message: "Notification unavailable" }))
              : Effect.void,
          ),
      },
      snapshotQuery: { getThreadShellsByIds: () => Effect.succeed(shells) },
      queuedTurnPromotions: {
        get listPendingThreadIds() {
          return Effect.sync(() => pending);
        },
      },
      commandReceipts,
      messages,
    } satisfies Parameters<typeof makeHubWorkService>[0] & { readonly messages: typeof messages };
    const service = makeHubWorkService(dependencies);
    const input = {
      callerThreadId: coordinator,
      requestId: "request",
      sourceMessages,
      tasks: sourceMessages.map((source, index) => ({
        spec: {
          prompt: `Task ${index}`,
          contextMessageIds: [source.messageId],
          target: { provider: "codex" as const, model: "fixture" },
        },
      })),
    };
    return {
      service,
      repository,
      projectId,
      coordinator,
      workerId,
      input,
      messages,
      commandReceipts,
      failNotifications: () => {
        notificationsFail = true;
      },
      setLimits: (maxNewWorkersPerTurn: number) =>
        Effect.gen(function* () {
          const current = yield* projectAgentRepository.getConfig(projectId);
          if (Option.isNone(current)) throw new Error("Missing test hub");
          yield* projectAgentRepository.saveConfig(
            {
              ...current.value,
              limits: { ...current.value.limits, maxNewWorkersPerTurn },
              revision: current.value.revision + 1,
            },
            current.value.revision,
          );
        }),
      restart: () => makeHubWorkService(dependencies),
      setShells: (value: OrchestrationThreadShell[]) => {
        shells = value;
      },
      setPending: (value: string[]) => {
        pending = value;
      },
    };
  });
}

tests("Hub work provenance, ownership and lifecycle", (it) => {
  it.effect(
    "freezes the original per-task messages and rejects changed plans and foreign progress writers",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("provenance");
        const result = yield* h.service.submit(h.input);
        assert.deepEqual(
          result.items.map((item) => item.sourceMessages.map((source) => source.text)),
          [["Original 1"], ["Original 2"]],
        );
        assert.equal(
          (yield* h.service.submit({ ...h.input, requestId: "next-wake" })).replayed,
          true,
        );
        assert.equal(
          Exit.isFailure(
            yield* Effect.exit(
              h.service.submit({
                ...h.input,
                tasks: [
                  { ...h.input.tasks[0]!, spec: { ...h.input.tasks[0]!.spec, prompt: "Changed" } },
                ],
              }),
            ),
          ),
          true,
        );
        const claimed = yield* h.service.claimNext(h.projectId);
        yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
        const update = {
          workItemId: claimed!.id,
          expectedRevision: 0,
          steps: [{ id: "check", text: "Verify original request", status: "completed" as const }],
        };
        assert.equal(
          Exit.isFailure(
            yield* Effect.exit(
              h.service.updateProgress({
                ...update,
                callerThreadId: ThreadId.makeUnsafe("different-worker"),
              }),
            ),
          ),
          true,
        );
        const saved = yield* h.service.updateProgress({ ...update, callerThreadId: h.workerId });
        assert.equal(saved.progress?.revision, 1);
        assert.equal(
          Exit.isFailure(
            yield* Effect.exit(h.service.updateProgress({ ...update, callerThreadId: h.workerId })),
          ),
          true,
        );
      }),
  );

  it.effect("freezes one worker per task key across retries, wakes and restarts", () =>
    Effect.gen(function* () {
      const h = yield* harness("keyed-routing");
      const keyed = {
        callerThreadId: h.coordinator,
        callerTurnId: TurnId.makeUnsafe(`${h.projectId}:turn:1`),
        requestId: "keyed-request",
        sourceMessages: h.input.sourceMessages,
        tasks: [
          {
            spec: { ...h.input.tasks[0]!.spec, taskKey: "Alpha", routingReason: "Ship the fix" },
          },
          {
            spec: { ...h.input.tasks[1]!.spec, taskKey: "beta", routingReason: "Add the test" },
          },
        ],
      };
      const first = yield* h.service.submit(keyed);
      assert.equal(first.replayed, false);
      assert.deepEqual(
        first.items.map((item) => item.taskKey),
        ["alpha", "beta"],
      );
      assert.deepEqual(
        first.items.map((item) => item.routingReason),
        ["Ship the fix", "Add the test"],
      );
      assert.equal(first.items[0]!.creationSpec.taskKey, "alpha");
      const ids = first.items.map((item) => item.id);

      // A retry in a later wake, under a different request id, must not fork work.
      const wake = yield* h.service.submit({
        ...keyed,
        callerTurnId: TurnId.makeUnsafe(`${h.projectId}:turn:2`),
        requestId: "later-wake",
      });
      assert.equal(wake.replayed, true);
      assert.deepEqual(
        wake.items.map((item) => item.id),
        ids,
      );

      // A restart reads the same frozen decisions from persistence.
      const restarted = yield* h.restart().submit({
        ...keyed,
        callerTurnId: TurnId.makeUnsafe(`${h.projectId}:turn:3`),
        requestId: "after-restart",
      });
      assert.equal(restarted.replayed, true);
      assert.deepEqual(
        (yield* h.repository.list(h.projectId)).map((item) => item.id),
        ids,
      );

      // The key is the server's: the same key with a different plan is refused
      // instead of creating a second worker.
      assert.equal(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.submit({
              ...keyed,
              requestId: "changed-plan",
              tasks: [
                {
                  spec: { ...h.input.tasks[0]!.spec, prompt: "Changed", taskKey: "alpha" },
                },
              ],
            }),
          ),
        ),
        true,
      );
      // A refined reason is not a different decision.
      assert.equal(
        (yield* h.service.submit({
          ...keyed,
          requestId: "refined-reason",
          tasks: [
            {
              spec: { ...h.input.tasks[0]!.spec, taskKey: "alpha", routingReason: "Fix bug" },
            },
          ],
        })).replayed,
        true,
      );
      // A key the server cannot freeze is refused, never silently replaced.
      assert.equal(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.submit({
              ...keyed,
              requestId: "unusable-key",
              tasks: [{ spec: { ...h.input.tasks[0]!.spec, taskKey: "not a key" } }],
            }),
          ),
        ),
        true,
      );
      assert.equal(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.submit({
              ...keyed,
              requestId: "duplicate-key",
              tasks: [
                { spec: { ...h.input.tasks[0]!.spec, taskKey: "gamma" } },
                { spec: { ...h.input.tasks[1]!.spec, taskKey: "GAMMA" } },
              ],
            }),
          ),
        ),
        true,
      );
      assert.equal((yield* h.repository.list(h.projectId)).length, 2);
    }),
  );

  it.effect("adds a new task from the same original message without reworking frozen tasks", () =>
    Effect.gen(function* () {
      const h = yield* harness("appended-routing");
      const submit = (keys: readonly string[], requestId: string) =>
        h.service.submit({
          callerThreadId: h.coordinator,
          requestId,
          sourceMessages: h.input.sourceMessages,
          tasks: keys.map((taskKey, index) => ({
            spec: { ...h.input.tasks[index]!.spec, taskKey },
          })),
        });
      const first = yield* submit(["alpha"], "plan-one");
      const claimed = yield* h.service.claimNext(h.projectId);
      yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
      const extended = yield* submit(["alpha", "gamma"], "plan-two");
      assert.equal(extended.replayed, false);
      assert.equal(extended.items.length, 2);
      assert.deepEqual(
        extended.items.map((item) => item.id),
        [first.items[0]!.id, extended.items[1]!.id],
      );
      // The frozen task keeps its worker and its position; only the new task is added.
      const frozen = (yield* h.repository.get(first.items[0]!.id))!;
      assert.equal(frozen.workerThreadId, h.workerId);
      assert.equal(frozen.taskIndex, 0);
      assert.equal((yield* h.repository.get(extended.items[1]!.id))?.taskIndex, 1);
      const originalReplay = yield* submit(["alpha"], "plan-one");
      assert.deepEqual(
        originalReplay.items.map((item) => item.id),
        [first.items[0]!.id],
      );
      yield* h.service.setState({ workItemId: frozen.id, state: "completed" });
      assert.equal((yield* h.service.claimNext(h.projectId))?.id, extended.items[1]?.id);
    }),
  );

  it.effect("replays an unkeyed request persisted before keyed routing", () =>
    Effect.gen(function* () {
      const h = yield* harness("legacy-routing");
      const initial = yield* h.service.submit(h.input);
      const legacyFingerprint = stableGatewayDigest(
        {
          sourceMessages: h.input.sourceMessages,
          tasks: h.input.tasks,
        },
        64,
      );
      // Model the pre-upgrade durable record and request receipt together.
      for (const item of initial.items) {
        const { taskKey: _key, taskFingerprint: _fingerprint, ...record } = item;
        yield* h.repository.save({
          record: {
            ...record,
            fingerprint: legacyFingerprint,
            revision: item.revision + 1,
          },
          expectedRevision: item.revision,
        });
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE project_agent_work_requests SET fingerprint = ${legacyFingerprint}
        WHERE project_id = ${h.projectId} AND request_id = ${h.input.requestId}`;
      const replay = yield* h.restart().submit(h.input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        replay.items.map((record) => record.id),
        initial.items.map((record) => record.id),
      );
    }),
  );

  it.effect("verifies a replay before refusing a saturated per-turn cap", () =>
    Effect.gen(function* () {
      const h = yield* harness("cap-replay");
      const plan = {
        callerThreadId: h.coordinator,
        requestId: "cap-plan",
        sourceMessages: h.input.sourceMessages,
        tasks: [0, 1].map((index) => ({
          spec: { ...h.input.tasks[index]!.spec, taskKey: `task-${index}` },
        })),
      };
      yield* h.setLimits(2);
      const first = yield* h.service.submit(plan);
      assert.equal(first.items.length, 2);
      yield* h.setLimits(1);
      // The frozen plan replays even though the cap no longer admits that many
      // workers: a replay starts nothing.
      const replayed = yield* h.service.submit({ ...plan, requestId: "cap-replay" });
      assert.equal(replayed.replayed, true);
      assert.deepEqual(
        replayed.items.map((item) => item.id),
        first.items.map((item) => item.id),
      );
      // Genuinely new work beyond the cap is still refused, even when the same
      // request also replays frozen tasks.
      assert.equal(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.submit({
              ...plan,
              requestId: "cap-overflow",
              tasks: [
                ...plan.tasks,
                { spec: { ...plan.tasks[0]!.spec, taskKey: "task-2" } },
                { spec: { ...plan.tasks[1]!.spec, taskKey: "task-3" } },
              ],
            }),
          ),
        ),
        true,
      );
      // One new task alongside replays stays within the cap.
      const extended = yield* h.service.submit({
        ...plan,
        requestId: "cap-extended",
        tasks: [...plan.tasks, { spec: { ...plan.tasks[0]!.spec, taskKey: "task-2" } }],
      });
      assert.equal(extended.items.length, 3);
      assert.equal((yield* h.repository.list(h.projectId)).length, 3);
    }),
  );

  it.effect(
    "replays followup admission and recovers a crash without freeing an already active slot",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("followup-service");
        yield* h.service.submit(h.input);
        const claimed = yield* h.service.claimNext(h.projectId);
        yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
        const command = {
          threadId: h.workerId,
          commandId: "followup-command",
          messageId: "followup-message",
        };
        const admission = yield* h.service.admitFollowup(command);
        const replay = yield* h.service.admitFollowup(command);
        assert.equal(replay?.revision, admission?.revision);
        assert.equal(replay?.admittedAt, admission?.admittedAt);
        assert.equal(
          Exit.isFailure(
            yield* Effect.exit(h.service.admitFollowup({ ...command, commandId: "another" })),
          ),
          true,
        );
        yield* h.service.recoverFollowupAdmissions(h.projectId);
        const restored = yield* h.repository.get(claimed!.id);
        assert.equal(restored?.state, "working");
        assert.equal(restored?.slotHeld, true);
        yield* h.service.setState({ workItemId: claimed!.id, state: "idle" });
        const idleAdmission = yield* h.service.admitFollowup({
          ...command,
          commandId: "idle-command",
        });
        yield* h.service.updateProgress({
          callerThreadId: h.workerId,
          workItemId: claimed!.id,
          expectedRevision: 0,
          steps: [],
        });
        yield* h.service.releaseFailedFollowup({
          workItemId: claimed!.id,
          admittedAt: idleAdmission!.admittedAt,
          commandId: idleAdmission!.admissionCommandId!,
          expectedRevision: idleAdmission!.revision,
        });
        assert.equal((yield* h.repository.get(claimed!.id))?.slotHeld, false);
        assert.equal(
          (yield* h.service.claimNext(h.projectId))?.id,
          (yield* h.repository.list(h.projectId))[1]!.id,
        );
      }),
  );

  it.effect(
    "keeps capacity for queued turns, releases it on settlement, and preserves cancellation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness("reconcile-service");
        yield* h.service.submit(h.input);
        const claimed = yield* h.service.claimNext(h.projectId);
        yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
        const shell = {
          id: h.workerId,
          archivedAt: null,
          session: null,
          latestTurn: {
            turnId: TurnId.makeUnsafe("completed"),
            state: "completed",
            requestedAt: "2099-01-01T00:00:00.000Z",
            startedAt: now,
            completedAt: now,
            assistantMessageId: null,
          },
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        } as unknown as OrchestrationThreadShell;
        h.setShells([shell]);
        h.setPending([h.workerId]);
        yield* h.service.reconcile(h.projectId);
        assert.equal((yield* h.repository.get(claimed!.id))?.slotHeld, true);
        h.setPending([]);
        yield* h.service.reconcile(h.projectId);
        assert.equal((yield* h.repository.get(claimed!.id))?.state, "idle");
        assert.equal((yield* h.repository.get(claimed!.id))?.slotHeld, false);
        yield* h.service.cancel({ workItemId: claimed!.id }, { kind: "user" });
        h.setShells([]);
        yield* h.service.reconcile(h.projectId);
        assert.equal((yield* h.repository.get(claimed!.id))?.state, "cancelled");
      }),
  );
  it.effect("keeps queued work durable while a hub is paused or its repository is unlinked", () =>
    Effect.gen(function* () {
      const h = yield* harness("queue-reasons");
      const target = ProjectId.makeUnsafe("unlinked-repository");
      yield* h.service.submit({
        ...h.input,
        tasks: [{ spec: { ...h.input.tasks[0]!.spec, projectId: target } }],
      });
      yield* h.service.reconcile(h.projectId);
      let item = (yield* h.repository.list(h.projectId))[0]!;
      assert.equal(item.queueReason, "Link this repository before starting");
      assert.equal(yield* h.service.claimNext(h.projectId), null);
      const configRepository = yield* ProjectAgentRepository;
      const current = yield* configRepository.getConfig(h.projectId);
      if (Option.isNone(current)) throw new Error("Missing test hub");
      yield* configRepository.saveConfig(
        { ...current.value, pausedAt: now, revision: current.value.revision + 1 },
        current.value.revision,
      );
      yield* h.service.reconcile(h.projectId);
      item = (yield* h.repository.list(h.projectId))[0]!;
      assert.equal(item.queueReason, "Resume this hub before starting work");
      assert.equal(item.state, "queued");
      assert.equal(item.workerThreadId, null);
    }),
  );
  it.effect("releases a native-steered worker when the same provider turn settles", () =>
    Effect.gen(function* () {
      const h = yield* harness("native-steer-settled");
      yield* h.service.submit(h.input);
      const claimed = yield* h.service.claimNext(h.projectId);
      yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
      const commandId = CommandId.makeUnsafe("native-steer:send");
      const messageId = MessageId.makeUnsafe("native-steer:message");
      const turnId = TurnId.makeUnsafe("original-provider-turn");
      const admission = yield* h.service.admitFollowup({
        threadId: h.workerId,
        commandId,
        messageId,
      });
      const completedAt = new Date(Date.parse(admission!.admittedAt!) + 1_000).toISOString();
      yield* h.commandReceipts.insert({
        commandId,
        aggregateKind: "thread",
        aggregateId: h.workerId,
        acceptedAt: admission!.admittedAt!,
        resultSequence: 1,
        status: "accepted",
        error: null,
        fingerprintVersion: 1,
        commandFingerprint: "a".repeat(64),
      });
      yield* h.messages.upsert({
        threadId: h.workerId,
        messageId,
        turnId: null,
        role: "user",
        text: "Native steer continuation",
        startsNewTurn: false,
        isStreaming: false,
        source: "native",
        createdAt: admission!.admittedAt!,
        updatedAt: admission!.admittedAt!,
      });
      h.setShells([
        {
          id: h.workerId,
          archivedAt: null,
          session: null,
          latestTurn: {
            turnId,
            state: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt,
            assistantMessageId: null,
          },
        } as unknown as OrchestrationThreadShell,
      ]);
      yield* h.service.reconcile(h.projectId);
      const settled = yield* h.repository.get(claimed!.id);
      assert.equal(settled?.slotHeld, false);
      assert.equal(settled?.state, "idle");
      assert.isNotNull(yield* h.service.claimNext(h.projectId));
    }),
  );

  it.effect("does not roll back another admission when the command identity differs", () =>
    Effect.gen(function* () {
      const h = yield* harness("mismatched-rollback");
      yield* h.service.submit(h.input);
      const claimed = yield* h.service.claimNext(h.projectId);
      yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
      yield* h.service.setState({ workItemId: claimed!.id, state: "idle" });
      const admission = yield* h.service.admitFollowup({
        threadId: h.workerId,
        commandId: "live-command",
        messageId: "live-message",
      });
      yield* h.service.releaseFailedFollowup({
        workItemId: claimed!.id,
        commandId: "stale-command",
        admittedAt: admission!.admittedAt,
        expectedRevision: admission!.revision,
      });
      const current = yield* h.repository.get(claimed!.id);
      assert.equal(current?.state, "starting");
      assert.equal(current?.slotHeld, true);
      assert.equal(current?.admissionCommandId, "live-command");
    }),
  );

  it.effect("returns durable followup admission when its notification fails", () =>
    Effect.gen(function* () {
      const h = yield* harness("notification-admission");
      yield* h.service.submit(h.input);
      const claimed = yield* h.service.claimNext(h.projectId);
      yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
      yield* h.service.setState({ workItemId: claimed!.id, state: "idle" });
      h.failNotifications();
      const result = yield* Effect.exit(
        h.service.admitFollowup({
          threadId: h.workerId,
          commandId: "notification-command",
          messageId: "notification-message",
        }),
      );
      assert.equal(Exit.isSuccess(result), true);
      const current = yield* h.repository.get(claimed!.id);
      assert.equal(current?.admissionCommandId, "notification-command");
      assert.equal(current?.slotHeld, true);
    }),
  );
  it.effect("releases admission when provider startup fails without creating a new turn", () =>
    Effect.gen(function* () {
      for (const status of ["error", "stopped"] as const) {
        const h = yield* harness(`startup-${status}`);
        yield* h.service.submit(h.input);
        const claimed = yield* h.service.claimNext(h.projectId);
        yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
        yield* h.service.setState({ workItemId: claimed!.id, state: "idle" });
        const commandId = CommandId.makeUnsafe(`startup-${status}:command`);
        const messageId = MessageId.makeUnsafe(`startup-${status}:message`);
        const admission = yield* h.service.admitFollowup({
          threadId: h.workerId,
          commandId,
          messageId,
        });
        yield* h.commandReceipts.insert({
          commandId,
          aggregateKind: "thread",
          aggregateId: h.workerId,
          acceptedAt: admission!.admittedAt!,
          resultSequence: 1,
          status: "accepted",
          error: null,
          fingerprintVersion: 1,
          commandFingerprint: "b".repeat(64),
        });
        yield* h.messages.upsert({
          threadId: h.workerId,
          messageId,
          turnId: null,
          role: "user",
          text: "Start a new turn",
          startsNewTurn: true,
          isStreaming: false,
          source: "native",
          createdAt: admission!.admittedAt!,
          updatedAt: admission!.admittedAt!,
        });
        h.setShells([
          {
            id: h.workerId,
            archivedAt: null,
            session: {
              status,
              updatedAt: admission!.admittedAt!,
              activeTurnId: null,
              lastError: "Provider startup failed",
            },
            latestTurn: {
              turnId: TurnId.makeUnsafe("old-turn"),
              state: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              assistantMessageId: null,
            },
          } as unknown as OrchestrationThreadShell,
        ]);
        yield* h.service.reconcile(h.projectId);
        const failed = yield* h.repository.get(claimed!.id);
        assert.equal(failed?.slotHeld, false);
        assert.equal(failed?.state, status === "error" ? "failed" : "idle");
        assert.isNotNull(yield* h.service.claimNext(h.projectId));
      }
    }),
  );

  it.effect("counts manual work on a cancelled task without rearming its delegation", () =>
    Effect.gen(function* () {
      const h = yield* harness("cancelled-manual-capacity");
      yield* h.service.submit(h.input);
      const claimed = yield* h.service.claimNext(h.projectId);
      yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
      yield* h.service.setState({ workItemId: claimed!.id, state: "idle" });
      yield* h.service.cancel({ workItemId: claimed!.id }, { kind: "user" });
      const shell = {
        id: h.workerId,
        archivedAt: null,
        session: null,
        latestTurn: {
          turnId: TurnId.makeUnsafe("manual-turn"),
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
      } as unknown as OrchestrationThreadShell;
      h.setShells([shell]);
      yield* h.service.reconcile(h.projectId);
      const active = yield* h.repository.get(claimed!.id);
      assert.equal(active?.state, "cancelled");
      assert.equal(active?.slotHeld, true);
      assert.equal(yield* h.service.claimNext(h.projectId), null);
      assert.equal(
        Exit.isFailure(
          yield* Effect.exit(
            h.service.admitFollowup({
              threadId: h.workerId,
              commandId: "must-not-rearm",
              messageId: "must-not-rearm-message",
            }),
          ),
        ),
        true,
      );
      h.setShells([
        { ...shell, latestTurn: { ...shell.latestTurn!, state: "completed", completedAt: now } },
      ]);
      yield* h.service.reconcile(h.projectId);
      assert.equal((yield* h.repository.get(claimed!.id))?.state, "cancelled");
      assert.equal((yield* h.repository.get(claimed!.id))?.slotHeld, false);
      assert.isNotNull(yield* h.service.claimNext(h.projectId));
    }),
  );

  it.effect("never rolls back a followup whose command already has an accepted receipt", () =>
    Effect.gen(function* () {
      const h = yield* harness("accepted-admission");
      yield* h.service.submit(h.input);
      const claimed = yield* h.service.claimNext(h.projectId);
      yield* h.service.attachWorker({ workItemId: claimed!.id, workerThreadId: h.workerId });
      const commandId = CommandId.makeUnsafe("accepted-admission:command");
      const admission = yield* h.service.admitFollowup({
        threadId: h.workerId,
        commandId,
        messageId: "accepted-admission:message",
      });
      yield* h.commandReceipts.insert({
        commandId,
        aggregateKind: "thread",
        aggregateId: h.workerId,
        acceptedAt: admission!.admittedAt!,
        resultSequence: 1,
        status: "accepted",
        error: null,
        fingerprintVersion: 1,
        commandFingerprint: "c".repeat(64),
      });
      yield* h.service.releaseFailedFollowup({
        workItemId: admission!.id,
        commandId,
        admittedAt: admission!.admittedAt,
        expectedRevision: admission!.revision,
      });
      const current = yield* h.repository.get(admission!.id);
      assert.equal(current?.state, "starting");
      assert.equal(current?.slotHeld, true);
      assert.equal(current?.admissionCommandId, commandId);
    }),
  );
});
