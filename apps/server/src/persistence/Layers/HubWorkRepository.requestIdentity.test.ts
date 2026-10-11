import { assert, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId, type HubWorkSourceMessage } from "@synara/contracts";
import { Effect, Layer } from "effect";

import { makeHubWorkService } from "../../projectAgent/hubWorkService";
import { HubWorkRepository } from "../Services/HubWorkRepository";
import { ProjectAgentRepository } from "../Services/ProjectAgentRepository";
import { HubWorkRepositoryLive } from "./HubWorkRepository";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const now = "2026-10-02T10:00:00.000Z";
const layer = it.layer(
  Layer.mergeAll(HubWorkRepositoryLive, ProjectAgentRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const makeFixture = Effect.fn(function* (name: string) {
  const repository = yield* HubWorkRepository;
  const projectAgentRepository = yield* ProjectAgentRepository;
  const projectId = ProjectId.makeUnsafe(`request-identity:${name}`);
  const callerThreadId = ThreadId.makeUnsafe(`${projectId}:coordinator`);
  yield* projectAgentRepository.saveConfig(
    {
      projectId,
      coordinatorThreadId: callerThreadId,
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
  const source: HubWorkSourceMessage = {
    threadId: callerThreadId,
    messageId: MessageId.makeUnsafe(`${projectId}:human`),
    turnId: null,
    text: "Implement the human task",
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
  const input = {
    callerThreadId,
    requestId: `${name}:original-request`,
    sourceMessages: [source],
    tasks: [
      {
        spec: {
          prompt: "Implement the human task",
          contextMessageIds: [source.messageId],
          target: { provider: "codex" as const, model: "fixture" },
        },
      },
    ],
  };
  const makeService = () =>
    makeHubWorkService({
      repository,
      projectAgentRepository,
      projectAgentService: {
        resolvePrincipalForThread: () =>
          Effect.succeed({ kind: "coordinator" as const, threadId: callerThreadId, projectId }),
        assertCallerMayCreateThreadInProject: () => Effect.void,
        notifyWorkItemChanged: () => Effect.void,
      },
    });
  return { repository, projectId, source, input, makeService, service: makeService() };
});

layer("Hub work request identity", (it) => {
  it.effect("clears original and replay request identities when a Hub's work data is deleted", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("deleted-hub-work");
      yield* fixture.service.submit(fixture.input);
      const aliasRequestId = "deleted-hub-work:later-wake";
      yield* fixture.service.submit({ ...fixture.input, requestId: aliasRequestId });
      yield* fixture.repository.deleteProject(fixture.projectId);
      assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 0);
      const otherSource = {
        ...fixture.source,
        messageId: MessageId.makeUnsafe(`${fixture.projectId}:new-human`),
        text: "A fresh request after deleting work data",
      };
      const resetInput = {
        ...fixture.input,
        sourceMessages: [otherSource],
        tasks: [
          { spec: { ...fixture.input.tasks[0]!.spec, contextMessageIds: [otherSource.messageId] } },
        ],
      };
      const fresh = yield* fixture.service.submit({ ...resetInput, requestId: aliasRequestId });
      assert.equal(fresh.replayed, false);
      const originalIdReplay = yield* fixture.service.submit(resetInput);
      assert.equal(originalIdReplay.replayed, true);
      assert.equal(originalIdReplay.items[0]!.id, fresh.items[0]!.id);
      assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 1);
    }),
  );

  it.effect(
    "preserves each task's selected original-message order within a shared source batch",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture("mixed-source-order");
        const second = {
          ...fixture.source,
          messageId: MessageId.makeUnsafe(`${fixture.projectId}:second-human`),
          text: "Second original constraint",
        };
        const result = yield* fixture.service.submit({
          ...fixture.input,
          sourceMessages: [fixture.source, second],
          tasks: [
            {
              spec: {
                ...fixture.input.tasks[0]!.spec,
                contextMessageIds: [fixture.source.messageId, second.messageId],
              },
            },
            {
              spec: {
                ...fixture.input.tasks[0]!.spec,
                contextMessageIds: [second.messageId, fixture.source.messageId],
              },
            },
          ],
        });
        assert.deepEqual(
          result.items.map((item) => item.sourceMessages.map((source) => source.messageId)),
          [
            [fixture.source.messageId, second.messageId],
            [second.messageId, fixture.source.messageId],
          ],
        );
        assert.deepEqual(
          result.items.map((item) => item.sourceMessages.map((source) => source.text)),
          [
            [fixture.source.text, second.text],
            [second.text, fixture.source.text],
          ],
        );
        assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 2);
      }),
  );

  it.effect(
    "rejects the same request ID after its canonical human source is edited, while a new request can delegate the edit",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture("edited-source");
        const initial = yield* fixture.service.submit(fixture.input);
        const edited = {
          ...fixture.input,
          sourceMessages: [
            {
              ...fixture.source,
              text: "Changed human constraints",
              updatedAt: "2026-10-02T10:01:00.000Z",
            },
          ],
        };
        const retry = yield* fixture.service.submit(edited).pipe(Effect.result);
        assert.equal(retry._tag, "Failure");
        if (retry._tag === "Failure") assert.equal(retry.failure.code, "conflict");
        assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 1);
        const newRequest = yield* fixture.service.submit({
          ...edited,
          requestId: "edited-source:new-request",
        });
        assert.equal(newRequest.replayed, false);
        assert.notEqual(newRequest.items[0]!.id, initial.items[0]!.id);
        assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 2);
      }),
  );

  it.effect("rejects a reordered source plan without generating another batch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("reordered-source");
      const second = {
        ...fixture.source,
        messageId: MessageId.makeUnsafe(`${fixture.projectId}:second-human`),
        text: "Second original constraint",
      };
      const input = {
        ...fixture.input,
        sourceMessages: [fixture.source, second],
        tasks: [
          {
            spec: {
              ...fixture.input.tasks[0]!.spec,
              contextMessageIds: [fixture.source.messageId, second.messageId],
            },
          },
        ],
      };
      yield* fixture.service.submit(input);
      const retry = yield* fixture.service
        .submit({
          ...input,
          requestId: "reordered-source:later-wake",
          sourceMessages: [second, fixture.source],
          tasks: [
            {
              spec: {
                ...input.tasks[0]!.spec,
                contextMessageIds: [second.messageId, fixture.source.messageId],
              },
            },
          ],
        })
        .pipe(Effect.result);
      assert.equal(retry._tag, "Failure");
      if (retry._tag === "Failure") assert.equal(retry.failure.code, "conflict");
      assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 1);
    }),
  );

  it.effect(
    "durably binds a replay alias request ID to its original source even after worker state writes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture("replay-alias");
        const original = yield* fixture.service.submit(fixture.input);
        const aliasRequestId = "replay-alias:later-wake";
        const replay = yield* fixture.service.submit({
          ...fixture.input,
          requestId: aliasRequestId,
        });
        assert.equal(replay.replayed, true);
        assert.equal(replay.items[0]!.id, original.items[0]!.id);
        const staleRecord = original.items[0]!;
        yield* fixture.repository.save({
          record: {
            ...staleRecord,
            queueReason: "Waiting for capacity",
            revision: staleRecord.revision + 1,
          },
          expectedRevision: staleRecord.revision,
        });
        const otherSource = {
          ...fixture.source,
          messageId: MessageId.makeUnsafe(`${fixture.projectId}:other-human`),
          text: "A different human request",
        };
        const retry = yield* fixture
          .makeService()
          .submit({
            ...fixture.input,
            requestId: aliasRequestId,
            sourceMessages: [otherSource],
            tasks: [
              {
                spec: {
                  ...fixture.input.tasks[0]!.spec,
                  contextMessageIds: [otherSource.messageId],
                },
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(retry._tag, "Failure");
        if (retry._tag === "Failure") assert.equal(retry.failure.code, "conflict");
        assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 1);
      }),
  );

  it.effect(
    "atomically accepts only one of two concurrent different source plans sharing a request ID",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture("concurrent-source");
        const otherSource = {
          ...fixture.source,
          messageId: MessageId.makeUnsafe(`${fixture.projectId}:other-human`),
          text: "An unrelated human request",
        };
        const outcomes = yield* Effect.all(
          [
            fixture.service.submit(fixture.input).pipe(Effect.result),
            fixture.service
              .submit({
                ...fixture.input,
                sourceMessages: [otherSource],
                tasks: [
                  {
                    spec: {
                      ...fixture.input.tasks[0]!.spec,
                      contextMessageIds: [otherSource.messageId],
                    },
                  },
                ],
              })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        assert.equal(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
        const failure = outcomes.find((outcome) => outcome._tag === "Failure");
        assert.isDefined(failure);
        if (failure?._tag === "Failure") assert.equal(failure.failure.code, "conflict");
        assert.lengthOf(yield* fixture.repository.list(fixture.projectId), 1);
      }),
  );
});
