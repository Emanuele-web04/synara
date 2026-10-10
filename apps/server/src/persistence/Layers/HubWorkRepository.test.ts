import { ProjectId, ThreadId, type HubWorkRecord } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { HubWorkRepository } from "../Services/HubWorkRepository";
import { ProjectAgentRepository } from "../Services/ProjectAgentRepository";
import { HubWorkRepositoryLive } from "./HubWorkRepository";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const layer = it.layer(
  Layer.mergeAll(HubWorkRepositoryLive, ProjectAgentRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);
const projectId = ProjectId.makeUnsafe("hub-queue");
const now = "2026-10-02T10:00:00.000Z";

function work(id: string, index: number): HubWorkRecord {
  return {
    id,
    projectId,
    targetProjectId: projectId,
    sourceThreadId: ThreadId.makeUnsafe("coordinator"),
    sourceMessageId: null,
    title: `Task ${index}`,
    workerThreadId: null,
    state: "queued",
    queueReason: "Waiting for capacity",
    resultSummary: null,
    progress: null,
    requestId: "request",
    scopeKey: "source",
    fingerprint: "plan",
    taskIndex: index,
    creationSpec: { prompt: `Task ${index}`, target: { provider: "codex", model: "gpt-5" } },
    sourceMessages: [],
    slotHeld: false,
    admittedAt: null,
    admissionCommandId: null,
    admissionMessageId: null,
    admissionPreviousState: null,
    admissionPreviousSlotHeld: false,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const configure = (hubId = projectId) =>
  Effect.gen(function* () {
    const repository = yield* ProjectAgentRepository;
    yield* repository.saveConfig(
      {
        projectId: hubId,
        coordinatorThreadId: ThreadId.makeUnsafe(`coordinator:${hubId}`),
        coordinatorName: "Hub",
        coordinatorModelSelection: { provider: "codex", model: "gpt-5" },
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
  });

layer("Hub work durable admission", (it) => {
  it.effect(
    "claims FIFO without oversubscribing concurrent starts and releases capacity durably",
    () =>
      Effect.gen(function* () {
        yield* configure();
        const repository = yield* HubWorkRepository;
        yield* repository.submit([work("first", 0), work("second", 1)]);
        const claims = yield* Effect.all(
          [repository.claimNext(projectId), repository.claimNext(projectId)],
          { concurrency: 2 },
        );
        assert.equal(claims.filter(Boolean).length, 1);
        const first = claims.find((claim) => claim !== null)!;
        assert.equal(first.id, "first");
        assert.equal(first.slotHeld, true);
        yield* repository.save({
          record: {
            ...first,
            state: "completed",
            slotHeld: false,
            admittedAt: null,
            admissionCommandId: null,
            admissionMessageId: null,
            admissionPreviousState: null,
            admissionPreviousSlotHeld: false,
            revision: first.revision + 1,
          },
          expectedRevision: first.revision,
        });
        const second = yield* repository.claimNext(projectId);
        assert.equal(second?.id, "second");
        assert.equal(second?.state, "starting");
      }),
  );

  it.effect(
    "replays frozen requests, rejects changed plans, and preserves progress against stale writes",
    () =>
      Effect.gen(function* () {
        const repository = yield* HubWorkRepository;
        const record = { ...work("replay", 0), projectId: ProjectId.makeUnsafe("hub-replay") };
        yield* repository.submit([record]);
        const replay = yield* repository.submit([record]);
        assert.equal(replay.replayed, true);
        const changed = yield* Effect.exit(
          repository.submit([{ ...record, fingerprint: "changed" }]),
        );
        assert.equal(Exit.isFailure(changed), true);
        const saved = yield* repository.save({
          record: {
            ...record,
            revision: 1,
            progress: {
              revision: 1,
              steps: [{ id: "read", text: "Read source", status: "completed" }],
            },
          },
          expectedRevision: 0,
        });
        const stale = yield* Effect.exit(
          repository.save({
            record: { ...record, revision: 1, progress: null },
            expectedRevision: 0,
          }),
        );
        assert.equal(Exit.isFailure(stale), true);
        assert.deepEqual((yield* repository.get(record.id))?.progress, saved.progress);
      }),
  );

  it.effect("never starts cancelled work or paused hubs", () =>
    Effect.gen(function* () {
      const repository = yield* HubWorkRepository;
      const configRepository = yield* ProjectAgentRepository;
      const pausedHub = ProjectId.makeUnsafe("hub-paused");
      yield* configure(pausedHub);
      const record = {
        ...work("cancelled", 0),
        projectId: pausedHub,
        targetProjectId: pausedHub,
        scopeKey: "cancelled",
      };
      yield* repository.submit([record]);
      yield* repository.save({
        record: { ...record, revision: 1, state: "cancelled" },
        expectedRevision: 0,
      });
      assert.equal(yield* repository.claimNext(pausedHub), null);
      yield* repository.submit([
        {
          ...work("paused", 0),
          projectId: pausedHub,
          targetProjectId: pausedHub,
          scopeKey: "paused",
          requestId: "paused-request",
        },
      ]);
      const existing = yield* configRepository.getConfig(pausedHub);
      if (existing._tag !== "Some") throw new Error("Expected configured hub");
      yield* configRepository.saveConfig(
        { ...existing.value, pausedAt: now, revision: existing.value.revision + 1 },
        existing.value.revision,
      );
      assert.equal(yield* repository.claimNext(pausedHub), null);
      assert.equal((yield* repository.get("cancelled"))?.state, "cancelled");
    }),
  );
  it.effect("re-admits an idle worker under the same atomic capacity boundary", () =>
    Effect.gen(function* () {
      const hub = ProjectId.makeUnsafe("hub-followup");
      yield* configure(hub);
      const repository = yield* HubWorkRepository;
      const first = {
        ...work("followup", 0),
        projectId: hub,
        targetProjectId: hub,
        workerThreadId: ThreadId.makeUnsafe("followup-worker"),
        state: "idle" as const,
      };
      const queued = { ...work("competing", 1), projectId: hub, targetProjectId: hub };
      yield* repository.submit([first, queued]);
      const admitted = yield* repository.reserveWorker({
        threadId: first.workerThreadId,
        commandId: "followup-command",
        messageId: "followup-message",
      });
      assert.equal(admitted?.slotHeld, true);
      assert.equal(admitted?.admissionPreviousSlotHeld, false);
      assert.equal(admitted?.admissionPreviousState, "idle");
      assert.equal(yield* repository.claimNext(hub), null);
      yield* repository.save({
        record: { ...admitted!, state: "working", revision: admitted!.revision + 1 },
        expectedRevision: admitted!.revision,
      });
      const continuing = yield* repository.reserveWorker({
        threadId: first.workerThreadId,
        commandId: "next-command",
        messageId: "next-message",
      });
      assert.equal(continuing?.admissionPreviousSlotHeld, true);
      assert.equal(yield* repository.claimNext(hub), null);
    }),
  );
});
