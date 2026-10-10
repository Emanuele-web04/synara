import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  THREAD_GOAL_INLINE_MAX_CHARS,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@synara/contracts";
import { makeKeyedDrainableWorker } from "@synara/shared/KeyedDrainableWorker";
import type { DrainableWorkerStatus } from "@synara/shared/DrainableWorker";
import fs from "node:fs/promises";
import path from "node:path";
import { Cause, Effect, Fiber, Layer, ManagedRuntime, Option, PubSub, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepository } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { materializeThreadGoalFile, pruneThreadGoalFiles } from "../threadGoalMaterialization.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive as OrchestrationProjectionSnapshotQueryBase } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";
import { ORCHESTRATION_EVENT_PUBSUB_CAPACITY } from "../orchestrationAdmission.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../serverSettings.ts";

const OrchestrationProjectionSnapshotQueryLive = OrchestrationProjectionSnapshotQueryBase.pipe(
  Layer.provide(ServerSettingsService.layerTest()),
);

/**
 * Command ids whose fingerprinting throws synchronously, standing in for any
 * synchronous defect raised while the worker builds a command's pipeline.
 */
const fingerprintPoison = vi.hoisted(() => new Set<string>());

vi.mock("@synara/shared/KeyedDrainableWorker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synara/shared/KeyedDrainableWorker")>();
  return { ...actual, makeKeyedDrainableWorker: vi.fn(actual.makeKeyedDrainableWorker) };
});

vi.mock("effect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect")>();
  return { ...actual, PubSub: { ...actual.PubSub, publish: vi.fn(actual.PubSub.publish) } };
});

vi.mock("../commandFingerprint.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commandFingerprint.ts")>();
  return {
    ...actual,
    fingerprintOrchestrationCommand: (command: OrchestrationCommand) => {
      if (fingerprintPoison.has(command.commandId)) {
        throw new TypeError("poisoned command fingerprint");
      }
      return actual.fingerprintOrchestrationCommand(command);
    },
  };
});

// Goal-file pruning is wrapped in vi.fn so a test can inject a one-shot
// rejection; every other materialization helper delegates to the real module.
vi.mock("../threadGoalMaterialization.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../threadGoalMaterialization.ts")>();
  return {
    ...actual,
    pruneThreadGoalFiles: vi.fn(actual.pruneThreadGoalFiles),
    materializeThreadGoalFile: vi.fn(actual.materializeThreadGoalFile),
  };
});

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

const makeThreadEventReadMethods = (
  events: ReadonlyArray<OrchestrationEvent>,
): Pick<
  OrchestrationEventStoreShape,
  | "getThreadHighWaterSequence"
  | "getThreadTitleHighWaterSequence"
  | "readThreadEvents"
  | "readThreadEventsFromSequence"
> => ({
  getThreadHighWaterSequence: (threadId) =>
    Effect.succeed(
      events
        .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
        .at(-1)?.sequence ?? 0,
    ),
  getThreadTitleHighWaterSequence: () => Effect.succeed(0),
  readThreadEvents: (input) =>
    Effect.succeed(
      events
        .filter(
          (event) =>
            event.aggregateKind === "thread" &&
            event.aggregateId === input.threadId &&
            event.sequence <= input.throughSequenceInclusive &&
            event.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER) &&
            (input.eventTypes === undefined || input.eventTypes.includes(event.type)),
        )
        .toSorted((left, right) => right.sequence - left.sequence)
        .slice(0, input.limit),
    ),
  readThreadEventsFromSequence: (
    threadId,
    sequenceExclusive,
    limit = 1_000,
    throughSequenceInclusive = Number.MAX_SAFE_INTEGER,
    eventTypes,
  ) =>
    Stream.fromIterable(
      events
        .filter(
          (event) =>
            event.aggregateKind === "thread" &&
            event.aggregateId === threadId &&
            event.sequence > sequenceExclusive &&
            event.sequence <= throughSequenceInclusive &&
            (eventTypes === undefined || eventTypes.includes(event.type)),
        )
        .slice(0, limit),
    ),
});
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

const TestServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-orchestration-engine-test-",
});

async function createOrchestrationSystem(pipeline?: OrchestrationProjectionPipelineShape) {
  const ServerConfigLayer = TestServerConfigLayer;
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(
      pipeline
        ? Layer.succeed(OrchestrationProjectionPipeline, pipeline)
        : OrchestrationProjectionPipelineLive,
    ),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const managedAttachmentRepository = await runtime.runPromise(
    Effect.service(ManagedAttachmentRepository),
  );
  const serverConfig = await runtime.runPromise(Effect.service(ServerConfig));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const receiptRepository = await runtime.runPromise(
    Effect.service(OrchestrationCommandReceiptRepository),
  );
  const runtimeRepository = await runtime.runPromise(
    Effect.service(ProviderRuntimeEventRepository),
  );
  const eventStore = await runtime.runPromise(Effect.service(OrchestrationEventStore));
  const projectionPipeline = await runtime.runPromise(
    Effect.service(OrchestrationProjectionPipeline),
  );
  return {
    engine,
    sql,
    receiptRepository,
    runtimeRepository,
    eventStore,
    projectionPipeline,
    managedAttachmentRepository,
    stateDir: serverConfig.stateDir,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return new Date().toISOString();
}

describe("OrchestrationEngine", () => {
  it("commits the metadata snapshot cursor before publishing its accepted event", async () => {
    const system = await createOrchestrationSystem();
    const commandId = CommandId.makeUnsafe("metadata-phase-commit");
    let cursorAtPublication: ReadonlyArray<{ sequence: number }> = [];
    const originalPublish = vi.mocked(PubSub.publish).getMockImplementation()!;
    const publish = vi.spyOn(PubSub, "publish").mockImplementation((pubsub, event) => {
      if ((event as OrchestrationEvent).commandId !== commandId)
        return originalPublish(pubsub, event);
      return system.sql<{ sequence: number }>`SELECT last_applied_sequence AS sequence
        FROM projection_state WHERE projector = 'projection.thread-shell-summaries'`.pipe(
        Effect.orDie,
        Effect.tap((rows) =>
          Effect.sync(() => {
            cursorAtPublication = rows;
          }),
        ),
        Effect.andThen(originalPublish(pubsub, event)),
      );
    });
    try {
      const accepted = await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId,
          projectId: asProjectId("metadata-phase-commit"),
          title: "Atomic metadata phase",
          workspaceRoot: "/tmp/metadata-phase-commit",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      expect(cursorAtPublication).toEqual([{ sequence: accepted.sequence }]);
      expect((await system.run(system.engine.getProjectionCatchUpStatus)).state).toBe("healthy");
    } finally {
      publish.mockRestore();
      await system.dispose();
    }
  });

  it("reserves lifecycle admission while a worker is finishing its released engine reservation", async () => {
    let releaseFinishing!: () => void;
    let finishingEntered!: () => void;
    const finishingGate = new Promise<void>((resolve) => {
      releaseFinishing = resolve;
    });
    const finishingStarted = new Promise<void>((resolve) => {
      finishingEntered = resolve;
    });
    let workerStatus: Effect.Effect<DrainableWorkerStatus> | undefined;
    const workerFactory = vi.mocked(makeKeyedDrainableWorker);
    const originalWorkerFactory = workerFactory.getMockImplementation()!;
    workerFactory.mockImplementation((process, options) =>
      originalWorkerFactory(
        (item) =>
          process(item).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                (item as { command: OrchestrationCommand }).command.commandId ===
                "reserve-actual-normal-0"
                  ? Effect.sync(finishingEntered).pipe(
                      Effect.andThen(Effect.promise(() => finishingGate)),
                    )
                  : Effect.void,
              ),
            ),
          ),
        options,
      ).pipe(
        Effect.tap((worker) =>
          Effect.sync(() => {
            workerStatus = worker.status;
          }),
        ),
      ),
    );
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("reserve-actual-project");
    const threadId = ThreadId.makeUnsafe("reserve-actual-thread");
    const createdAt = now();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalAppend = system.eventStore.append;
    const pending: Array<Promise<import("effect").Exit.Exit<unknown, unknown>>> = [];
    let append: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("reserve-actual-project"),
          projectId,
          title: "Reserve",
          workspaceRoot: "/tmp/reserve-actual",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("reserve-actual-thread"),
          threadId,
          projectId,
          title: "Reserve",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      append = vi
        .spyOn(system.eventStore, "append")
        .mockImplementation((event) =>
          originalAppend(event).pipe(
            Effect.tap(() =>
              event.commandId === "reserve-actual-normal-0"
                ? Effect.sync(entered).pipe(Effect.andThen(Effect.promise(() => gate)))
                : Effect.void,
            ),
          ),
        );
      const admitNormal = (index: number) =>
        system.run(
          Effect.exit(
            system.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe(`reserve-actual-normal-${index}`),
              threadId,
              title: `Normal ${index}`,
            }),
          ),
        );
      pending.push(admitNormal(0));
      await started;
      for (let index = 1; index < 224; index++) pending.push(admitNormal(index));
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("reserve-actual-normal-overflow"),
            threadId,
            title: "Overflow",
          }),
        ),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandAdmissionError", reason: "overloaded" });
      for (let index = 0; index < 32; index++)
        pending.push(
          system.run(
            Effect.exit(
              system.engine.dispatch({
                type: "thread.session.stop",
                commandId: CommandId.makeUnsafe(`reserve-actual-control-${index}`),
                threadId,
                createdAt,
              }),
            ),
          ),
        );
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe("reserve-actual-control-overflow"),
            threadId,
            createdAt,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandAdmissionError", reason: "overloaded" });
      release();
      await finishingStarted;
      pending.push(
        system.run(
          Effect.exit(
            system.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.makeUnsafe("reserve-actual-control-refill"),
              threadId,
              createdAt,
            }),
          ),
        ),
      );
      // The engine released one reservation, but the real worker is still closing it.
      await vi.waitFor(async () => expect((await system.run(workerStatus!)).outstanding).toBe(257));
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe("reserve-actual-control-refill-overflow"),
            threadId,
            createdAt,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandAdmissionError", reason: "overloaded" });
      releaseFinishing();
      const outcomes = await Promise.all(pending);
      expect(outcomes).toHaveLength(257);
      for (const outcome of outcomes) {
        if (outcome._tag === "Failure") {
          const error = Cause.findErrorOption(outcome.cause);
          if (Option.isSome(error))
            expect(error.value).not.toMatchObject({ _tag: "OrchestrationCommandAdmissionError" });
        }
      }
    } finally {
      releaseFinishing();
      release();
      await Promise.allSettled(pending);
      append?.mockRestore();
      await system.dispose();
      workerFactory.mockImplementation(originalWorkerFactory);
    }
  });

  it("rejects a project deletion decided after its thread creation commits", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("delete-create-project");
    const threadId = ThreadId.makeUnsafe("delete-create-thread");
    const createdAt = now();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalAppend = system.eventStore.append;
    const append = vi
      .spyOn(system.eventStore, "append")
      .mockImplementation((event) =>
        originalAppend(event).pipe(
          Effect.tap(() =>
            event.type === "thread.created"
              ? Effect.sync(entered).pipe(Effect.andThen(Effect.promise(() => gate)))
              : Effect.void,
          ),
        ),
      );
    const pending: Promise<unknown>[] = [];
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("delete-create-project"),
          projectId,
          title: "Delete race",
          workspaceRoot: "/tmp/delete-create",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      const creation = system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("delete-create-thread"),
          projectId,
          threadId,
          title: "Create first",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      pending.push(creation);
      await started;
      const commandId = CommandId.makeUnsafe("delete-create-delete");
      const deletion = system.run(
        Effect.exit(
          system.engine.dispatch({
            type: "project.delete",
            commandId,
            projectId,
          }),
        ),
      );
      pending.push(deletion);
      release();
      await creation;
      expect((await deletion)._tag).toBe("Failure");
      const model = await system.run(system.engine.getReadModel());
      expect(model.threads.map((thread) => thread.id)).toEqual([threadId]);
      expect(model.projects.find((project) => project.id === projectId)?.deletedAt).toBeNull();
      const receipt = await system.run(system.receiptRepository.getByCommandId({ commandId }));
      expect(Option.isSome(receipt) && receipt.value.status).toBe("rejected");
      const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
      expect(events.map((event) => event.type)).toEqual(["project.created", "thread.created"]);
    } finally {
      release();
      await Promise.allSettled(pending);
      append.mockRestore();
      await system.dispose();
    }
  });

  it("does not reconcile the journal for an invariant rejected before persistence", async () => {
    const system = await createOrchestrationSystem();
    const reads = vi.spyOn(system.eventStore, "readFromSequence");
    try {
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("precommit-invariant"),
            threadId: ThreadId.makeUnsafe("absent-precommit-thread"),
            title: "Cannot commit",
          }),
        ),
      ).rejects.toThrow();
      expect(reads).not.toHaveBeenCalled();
      expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(0);
    } finally {
      reads.mockRestore();
      await system.dispose();
    }
  });

  it("refreshes purged command rows when the hot fence is current and deferred summaries lag", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("refresh-purged-project");
    const threadId = ThreadId.makeUnsafe("refresh-purged-thread");
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("refresh-purged-project"),
          projectId,
          title: "Refresh purge",
          workspaceRoot: "/tmp/refresh-purged",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      const accepted = await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("refresh-purged-thread"),
          threadId,
          projectId,
          title: "Purge me",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(system.engine.drain);
      // Local purge can remove a shell without producing another domain event.
      // Lagging deferred summaries must not preserve that removed command row.
      await system.run(
        system.sql.withTransaction(
          Effect.gen(function* () {
            yield* system.sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
            yield* system.sql`UPDATE projection_state SET last_applied_sequence = 0
          WHERE projector = 'projection.thread-shell-summaries'`;
          }),
        ),
      );
      expect(
        (await system.run(system.engine.getReadModel())).threads.map((thread) => thread.id),
      ).toContain(threadId);
      const refreshed = await system.run(system.engine.refreshCommandReadModel());
      expect(refreshed.snapshotSequence).toBe(accepted.sequence);
      expect(refreshed.threads.map((thread) => thread.id)).not.toContain(threadId);
    } finally {
      await system.dispose();
    }
  });

  it("preserves committed hot summaries and every publication when interrupted after commit", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("interrupted-publication-project");
    const threadId = ThreadId.makeUnsafe("interrupted-publication-thread");
    const createdAt = now();
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("interrupted-publication-project"),
        projectId,
        title: "Committed publication",
        workspaceRoot: "/tmp/interrupted-publication",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("interrupted-publication-thread"),
        projectId,
        threadId,
        title: "Committed publication",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const commandId = CommandId.makeUnsafe("interrupted-publication-turn");
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let enteredPublication!: (fiber: Fiber.Fiber<unknown, unknown>) => void;
    const publicationEntered = new Promise<Fiber.Fiber<unknown, unknown>>((resolve) => {
      enteredPublication = resolve;
    });
    const originalPublish = vi.mocked(PubSub.publish).getMockImplementation()!;
    let gated = false;
    const publish = vi.spyOn(PubSub, "publish").mockImplementation((pubsub, event) => {
      if ((event as OrchestrationEvent).commandId !== commandId || gated)
        return originalPublish(pubsub, event);
      gated = true;
      return originalPublish(pubsub, event).pipe(
        Effect.tap(() =>
          Effect.withFiber((fiber) => Effect.sync(() => enteredPublication(fiber))).pipe(
            Effect.andThen(Effect.promise(() => publicationGate)),
          ),
        ),
      );
    });
    const notifications = Effect.runFork(
      Effect.scoped(
        system.engine.subscribeDomainEvents.pipe(
          Effect.flatMap((events) => Stream.runCollect(Stream.take(events, 2))),
        ),
      ),
    );
    const command = {
      type: "thread.turn.start" as const,
      commandId,
      threadId,
      message: {
        messageId: asMessageId("interrupted-publication-user"),
        role: "user" as const,
        text: "Commit before cancel",
        attachments: [],
      },
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      createdAt,
    };
    const dispatch = Effect.runFork(system.engine.dispatch(command));
    try {
      const worker = await Promise.race([
        publicationEntered,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Publication not reached")), 1000),
        ),
      ]);
      const interruption = Effect.runFork(Fiber.interrupt(worker));
      await Effect.runPromise(Effect.yieldNow);
      releasePublication();
      await Effect.runPromise(Fiber.join(interruption));
      await system.run(system.engine.drain);
      const receipt = Option.getOrThrow(
        await system.run(system.receiptRepository.getByCommandId({ commandId })),
      );
      expect(receipt.status).toBe("accepted");
      const published = Array.from(await Effect.runPromise(Fiber.join(notifications)));
      expect(published.map((event) => event.commandId)).toEqual([commandId, commandId]);
      expect(published.map((event) => event.sequence)).toEqual([
        receipt.resultSequence - 1,
        receipt.resultSequence,
      ]);
      const summary = await system.run(system.sql<{ userAt: string; humanAt: string }>`
        SELECT latest_user_message_at AS "userAt", latest_human_message_at AS "humanAt"
        FROM projection_threads WHERE thread_id = ${threadId}
      `);
      expect(summary).toEqual([{ userAt: createdAt, humanAt: createdAt }]);
      const cursors = await system.run(system.sql<{
        sequence: number;
      }>`SELECT last_applied_sequence AS sequence
        FROM projection_state WHERE projector IN ('projection.hot', 'projection.thread-shell-summaries') ORDER BY projector`);
      expect(cursors).toEqual([
        { sequence: receipt.resultSequence },
        { sequence: receipt.resultSequence },
      ]);
      expect(await system.run(system.engine.dispatch(command))).toEqual({
        sequence: receipt.resultSequence,
      });
      expect(
        Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0)))),
      ).toHaveLength(4);
    } finally {
      releasePublication();
      publish.mockRestore();
      await Effect.runPromise(Fiber.interrupt(notifications));
      await Effect.runPromise(Fiber.interrupt(dispatch));
      await system.dispose();
    }
  });

  it.each(["global", "thread"] as const)(
    "bounds eager persisted decoding for a %s journal page and resumes without skipping rows",
    async (scope) => {
      const system = await createOrchestrationSystem();
      const projectId = asProjectId("bounded-page-project");
      const threadId = ThreadId.makeUnsafe("bounded-page-thread");
      const createdAt = now();
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("bounded-page-project"),
            projectId,
            title: "Bounded page",
            workspaceRoot: "/tmp/bounded-page",
            defaultModelSelection: null,
            createdAt,
          }),
        );
        const created = await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("bounded-page-thread"),
            threadId,
            projectId,
            title: "Bounded page",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
        const sequences: number[] = [];
        for (let index = 0; index < 33; index++) {
          const result = await system.run(
            system.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe(`bounded-page-${index}`),
              threadId,
              title: `Bounded ${index}`,
            }),
          );
          sequences.push(result.sequence);
        }
        await system.run(system.engine.drain);
        const through = sequences.at(-1)!;
        const original = await system.run(
          system.sql<{
            payload: string;
          }>`SELECT payload_json AS payload FROM orchestration_events WHERE sequence = ${through}`,
        );
        await system.run(
          system.sql`UPDATE orchestration_events SET payload_json = '{}' WHERE sequence = ${through}`,
        );
        const read = (from: number, limit?: number) =>
          Stream.runCollect(
            scope === "global"
              ? system.engine.readEventsThrough(from, through, limit)
              : system.engine.readThreadEventsThrough(threadId, from, through, undefined, limit),
          ).pipe(Effect.mapError((error) => new Error(error.message)));
        await expect(system.run(read(created.sequence))).rejects.toThrow();
        const prefix = await system.run(read(created.sequence, 32));
        expect(prefix.map((event) => event.sequence)).toEqual(sequences.slice(0, 32));
        await system.run(
          system.sql`UPDATE orchestration_events SET payload_json = ${original[0]!.payload} WHERE sequence = ${through}`,
        );
        const resumed = await system.run(read(prefix.at(-1)!.sequence, 32));
        expect([...prefix, ...resumed].map((event) => event.sequence)).toEqual(sequences);
        expect((await system.run(read(created.sequence))).map((event) => event.sequence)).toEqual(
          sequences,
        );
      } finally {
        await system.dispose();
      }
    },
  );

  it("omits checkpoint runtime cuts for standalone assistant deltas while fencing turn starts", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("checkpoint-fence-project");
    const threadId = ThreadId.makeUnsafe("checkpoint-fence-thread");
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("checkpoint-fence-project-create"),
          projectId,
          title: "Checkpoint fence",
          workspaceRoot: "/tmp/checkpoint-fence",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("checkpoint-fence-thread-create"),
          threadId,
          projectId,
          title: "Checkpoint fence",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      const first = await system.run(
        system.runtimeRepository.append({
          type: "turn.completed",
          eventId: EventId.makeUnsafe("standalone-delta-native-before"),
          provider: "codex",
          threadId,
          turnId: asTurnId("standalone-delta-native-turn"),
          createdAt,
          payload: { state: "completed" },
        }),
      );
      const delta: OrchestrationCommand = {
        type: "thread.message.assistant.delta",
        commandId: CommandId.makeUnsafe("standalone-delta-command"),
        threadId,
        messageId: asMessageId("standalone-delta-message"),
        delta: "Streaming text",
        createdAt,
      };
      const deltaReceipt = await system.run(system.engine.dispatch(delta));
      expect(await system.run(system.engine.dispatch(delta))).toEqual(deltaReceipt);
      const deltaEvents = Array.from(
        await system.run(Stream.runCollect(system.engine.readEvents(0))),
      ).filter((event) => event.commandId === delta.commandId);
      expect(deltaEvents).toHaveLength(1);
      expect(deltaEvents[0]?.type).toBe("thread.message-sent");
      expect(deltaEvents[0]?.metadata).not.toHaveProperty("checkpointRuntimeSequence");

      const start: OrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("standalone-delta-turn-start"),
        threadId,
        message: {
          messageId: asMessageId("standalone-delta-user-message"),
          role: "user",
          text: "Start a turn",
          attachments: [],
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        createdAt,
      };
      const startReceipt = await system.run(system.engine.dispatch(start));
      expect(await system.run(system.engine.dispatch(start))).toEqual(startReceipt);
      const startEvents = Array.from(
        await system.run(Stream.runCollect(system.engine.readEvents(0))),
      ).filter((event) => event.commandId === start.commandId);
      expect(startEvents.some((event) => event.type === "thread.turn-start-requested")).toBe(true);
      for (const event of startEvents) {
        expect(event.metadata).toMatchObject({ checkpointRuntimeSequence: first.sequence });
      }
    } finally {
      await system.dispose();
    }
  });

  it("persists a server-owned runtime fence with checkpoint requests and preserves it on receipt retries", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("checkpoint-fence-project");
    const threadId = ThreadId.makeUnsafe("checkpoint-fence-thread");
    const createdAt = now();
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("checkpoint-fence-project-create"),
          projectId,
          title: "Checkpoint fence",
          workspaceRoot: "/tmp/checkpoint-fence",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("checkpoint-fence-thread-create"),
          threadId,
          projectId,
          title: "Checkpoint fence",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      const repository = system.runtimeRepository;
      const append = (id: string) =>
        system.run(
          repository.append({
            type: "turn.completed",
            eventId: EventId.makeUnsafe(id),
            provider: "codex",
            threadId,
            turnId: asTurnId("checkpoint-fence-turn"),
            createdAt,
            payload: { state: "completed" },
          }),
        );
      const first = await append("checkpoint-fence-before");
      const command: OrchestrationCommand = {
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("checkpoint-fence-revert"),
        threadId,
        turnCount: 1,
        createdAt,
      };
      const receipt = await system.run(system.engine.dispatch(command));
      await append("checkpoint-fence-after");
      expect(await system.run(system.engine.dispatch(command))).toEqual(receipt);
      const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
      const requests = events.filter(
        (event) => event.type === "thread.checkpoint-revert-requested",
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.metadata).toMatchObject({ checkpointRuntimeSequence: first.sequence });
    } finally {
      await system.dispose();
    }
  });

  it.each([false, true])(
    "publishes a ready control before queued normal commits with cancelled maintenance waiter=%s",
    async (cancelWaiter) => {
      const system = await createOrchestrationSystem();
      const projectId = asProjectId("commit-priority-project");
      const threads = ["active", "normal-first", "normal-second", "control"].map((name) =>
        ThreadId.makeUnsafe(`commit-priority-${name}`),
      );
      const createdAt = now();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const active = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending: Promise<unknown>[] = [];
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("commit-priority-project"),
            projectId,
            title: "Commit priority",
            workspaceRoot: "/tmp/commit-priority",
            defaultModelSelection: null,
            createdAt,
          }),
        );
        for (const threadId of threads) {
          await system.run(
            system.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe(`create-${threadId}`),
              threadId,
              projectId,
              title: "Before",
              modelSelection: { provider: "codex", model: "gpt-5-codex" },
              interactionMode: "default",
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt,
            }),
          );
        }
        await system.run(system.engine.drain);
        const titleSequence = await system.run(
          system.eventStore.getThreadTitleHighWaterSequence(threads[0]!),
        );
        const titleRead = system.eventStore.getThreadTitleHighWaterSequence.bind(system.eventStore);
        vi.spyOn(system.eventStore, "getThreadTitleHighWaterSequence").mockImplementation((id) =>
          id === threads[0]
            ? Effect.promise(async () => {
                entered();
                await gate;
              }).pipe(Effect.andThen(titleRead(id)))
            : titleRead(id),
        );
        let subscribed!: () => void;
        const subscriptionReady = new Promise<void>((resolve) => {
          subscribed = resolve;
        });
        const publications = system.run(
          Effect.scoped(
            Effect.gen(function* () {
              const stream = yield* system.engine.subscribeDomainEvents;
              subscribed();
              return yield* Stream.runCollect(stream.pipe(Stream.take(4)));
            }),
          ),
        );
        pending.push(publications);
        await subscriptionReady;
        pending.push(
          system.run(
            system.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe("commit-active"),
              threadId: threads[0]!,
              title: "Active",
              expectedTitleSequence: titleSequence,
            }),
          ),
        );
        await system.run(Effect.promise(() => active).pipe(Effect.timeout("1 second")));
        if (cancelWaiter) {
          // This caller owns a queued maintenance lease. Cancellation must
          // remove that lease without consuming the next command's permit.
          const refresh = Effect.runFork(system.engine.refreshCommandReadModel());
          await system.run(Effect.yieldNow);
          await system.run(Fiber.interrupt(refresh));
        }
        const receiptRead = system.receiptRepository.getByCommandId.bind(system.receiptRepository);
        const prepared = new Map<string, () => void>();
        vi.spyOn(system.receiptRepository, "getByCommandId").mockImplementation((id) =>
          receiptRead(id).pipe(Effect.tap(() => Effect.sync(() => prepared.get(id.commandId)?.()))),
        );
        for (const [index, id] of [
          "commit-normal-first",
          "commit-normal-second",
          "commit-control",
        ].entries()) {
          let ready!: () => void;
          const preparationFinished = new Promise<void>((resolve) => {
            ready = resolve;
          });
          prepared.set(id, ready);
          pending.push(
            system.run(
              system.engine.dispatch(
                index === 2
                  ? {
                      type: "thread.session.stop",
                      commandId: CommandId.makeUnsafe(id),
                      threadId: threads[index + 1]!,
                      createdAt,
                    }
                  : {
                      type: "thread.meta.update",
                      commandId: CommandId.makeUnsafe(id),
                      threadId: threads[index + 1]!,
                      title: id,
                    },
              ),
            ),
          );
          await system.run(
            Effect.promise(() => preparationFinished).pipe(Effect.timeout("1 second")),
          );
          // Preparation has no more asynchronous work before the commit gate.
          await system.run(Effect.yieldNow);
          await system.run(Effect.yieldNow);
        }
        release();
        await Promise.all(pending);
        expect((await publications).map((event) => event.commandId)).toEqual([
          "commit-active",
          "commit-control",
          "commit-normal-first",
          "commit-normal-second",
        ]);
        await system.run(system.engine.drain.pipe(Effect.timeout("300 millis")));
        // A later command also proves the cancelled maintenance lease did not
        // leak a permit after the ready queue was exhausted.
        await system.run(
          system.engine
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe("commit-after-cancellation"),
              threadId: threads[0]!,
              title: "After",
            })
            .pipe(Effect.timeout("300 millis")),
        );
      } finally {
        release();
        await Promise.allSettled(pending);
        vi.restoreAllMocks();
        await system.dispose();
      }
    },
  );

  it.each(["materialization", "housekeeping"] as const)(
    "commits another aggregate while goal %s is blocked and preserves same-thread FIFO",
    async (phase) => {
      const system = await createOrchestrationSystem();
      const projectId = asProjectId("lane-project");
      const threadId = ThreadId.makeUnsafe("lane-thread");
      const createdAt = now();
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending: Promise<unknown>[] = [];
      try {
        await system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("lane-project-create"),
            projectId,
            title: "Lanes",
            workspaceRoot: "/tmp/lane-project",
            defaultModelSelection: null,
            createdAt,
          }),
        );
        await system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("lane-thread-create"),
            threadId,
            projectId,
            title: "Before",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
        let subscriptionReady!: () => void;
        const subscribed = new Promise<void>((resolve) => {
          subscriptionReady = resolve;
        });
        const published = system.run(
          Effect.scoped(
            Effect.gen(function* () {
              const stream = yield* system.engine.subscribeDomainEvents;
              subscriptionReady();
              return yield* Stream.runCollect(stream.pipe(Stream.take(3)));
            }),
          ),
        );
        pending.push(published);
        await subscribed;
        if (phase === "housekeeping") {
          vi.mocked(pruneThreadGoalFiles).mockImplementationOnce(async () => {
            started();
            await gate;
          });
        } else {
          const actual = await vi.importActual<typeof import("../threadGoalMaterialization.ts")>(
            "../threadGoalMaterialization.ts",
          );
          vi.mocked(materializeThreadGoalFile).mockImplementationOnce(async (input) => {
            started();
            await gate;
            return actual.materializeThreadGoalFile(input);
          });
        }
        pending.push(
          system.run(
            system.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe("lane-thread-goal"),
              threadId,
              goal:
                phase === "housekeeping"
                  ? "Keep working"
                  : "g".repeat(THREAD_GOAL_INLINE_MAX_CHARS + 1),
            }),
          ),
        );
        await blocked;
        let sameThreadSettled = false;
        pending.push(
          system
            .run(
              system.engine.dispatch({
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe("lane-thread-next"),
                threadId,
                title: "After",
              }),
            )
            .then(() => {
              sameThreadSettled = true;
            }),
        );
        const other = system.run(
          system.engine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("lane-project-next"),
            projectId,
            title: "Independent",
          }),
        );
        pending.push(other);
        const result = await Promise.race([
          other,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
        ]);
        expect(result).not.toBeNull();
        expect(sameThreadSettled).toBe(false);
        const snapshot = await system.run(system.engine.getReadModel());
        expect(snapshot.projects.find((entry) => entry.id === projectId)?.title).toBe(
          "Independent",
        );
        if (phase === "housekeeping")
          expect(snapshot.threads.find((entry) => entry.id === threadId)?.goal).toBe(
            "Keep working",
          );
        release();
        const liveEvents = await published;
        expect(Array.from(liveEvents).map((event) => event.sequence)).toEqual([3, 4, 5]);
      } finally {
        release();
        await Promise.allSettled(pending);
        await system.dispose();
      }
    },
  );

  it.each([false, true])(
    "settles an uncertain send without executing it again (already accepted=%s)",
    async (accepted) => {
      const system = await createOrchestrationSystem();
      const { engine } = system;
      const createdAt = now();
      const projectId = asProjectId("settlement-project");
      const threadId = ThreadId.makeUnsafe("settlement-thread");
      try {
        await system.run(
          engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("settlement-project-create"),
            projectId,
            title: "Settlement",
            workspaceRoot: "/tmp/settlement",
            defaultModelSelection: null,
            createdAt,
          }),
        );
        await system.run(
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("settlement-thread-create"),
            threadId,
            projectId,
            title: "Settlement",
            modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
        const command = {
          type: "thread.turn.start" as const,
          commandId: CommandId.makeUnsafe("settlement-send"),
          threadId,
          message: {
            messageId: asMessageId("settlement-message"),
            role: "user" as const,
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdAt,
        };
        const original = accepted ? await system.run(engine.dispatch(command)) : null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const settlement = system.run(engine.dispatch(command, { settleOnly: true }));
          if (accepted) {
            await expect(settlement).resolves.toEqual(original);
          } else {
            await expect(settlement).rejects.toMatchObject({
              _tag: "OrchestrationCommandPreviouslyRejectedError",
            });
          }
        }
        // A delayed original RPC must see the rejection recorded by settlement.
        if (!accepted) {
          await expect(system.run(engine.dispatch(command))).rejects.toMatchObject({
            _tag: "OrchestrationCommandPreviouslyRejectedError",
          });
        }
        await system.run(engine.quiesce);
        const shutdownSettlement = system.run(engine.dispatch(command, { settleOnly: true }));
        if (accepted) await expect(shutdownSettlement).resolves.toEqual(original);
        else
          await expect(shutdownSettlement).rejects.toMatchObject({
            _tag: "OrchestrationCommandPreviouslyRejectedError",
          });
        const events = await system.run(Stream.runCollect(engine.readEvents(0)));
        expect(
          Array.from(events).filter((event) => event.type === "thread.turn-start-requested"),
        ).toHaveLength(accepted ? 1 : 0);
      } finally {
        await system.dispose();
      }
    },
  );

  it.each([false, true])(
    "persists async questions and admits one concurrent answer (running=%s)",
    async (running) => {
      const system = await createOrchestrationSystem();
      const { engine } = system;
      const createdAt = now();
      const threadId = ThreadId.makeUnsafe("async-question-thread");
      const projectId = asProjectId("async-question-project");
      const questionId = asMessageId("assistant:async-question");
      const turnId = asTurnId("question-turn");
      let index = 0;
      const commandId = () => CommandId.makeUnsafe(`async-question-${++index}`);
      const questions = [
        { title: "When does it happen?", options: ["On launch", "On reconnect"] },
        { title: "Any other details?" },
      ];
      try {
        await system.run(
          engine.dispatch({
            type: "project.create",
            commandId: commandId(),
            projectId,
            title: "Async input",
            workspaceRoot: "/tmp/async-input",
            defaultModelSelection: null,
            createdAt,
          }),
        );
        await system.run(
          engine.dispatch({
            type: "thread.create",
            commandId: commandId(),
            threadId,
            projectId,
            title: "Async input",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: "default",
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
        await system.run(
          engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: commandId(),
            threadId,
            messageId: questionId,
            turnId,
            delta: "When does it happen?",
            createdAt,
          }),
        );
        const completeQuestion = () =>
          engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: commandId(),
            threadId,
            messageId: questionId,
            turnId,
            asyncQuestions: questions,
            createdAt,
          });
        await system.run(completeQuestion());
        await system.run(
          engine.dispatch({
            type: "thread.session.set",
            commandId: commandId(),
            threadId,
            session: {
              threadId,
              providerName: "codex",
              status: running ? "running" : "ready",
              activeTurnId: running ? turnId : null,
              runtimeMode: "approval-required",
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
        const before = (await system.run(engine.getReadModel())).threads[0]!;
        expect(
          before.messages.find((message) => message.id === questionId)?.asyncUserInput,
        ).toEqual({ questions });
        expect(before.activities.some((activity) => activity.kind === "user-input.requested")).toBe(
          false,
        );
        const answer = (suffix: string, answers = ["On reconnect", "Only after sleep"]) =>
          engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId(),
            threadId,
            message: {
              messageId: asMessageId(`answer-${suffix}`),
              role: "user",
              text: "client placeholder",
              attachments: [],
            },
            asyncUserInputResponse: { messageId: questionId, answers },
            dispatchMode: "queue",
            runtimeMode: "full-access",
            interactionMode: "plan",
            createdAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
          });
        await expect(system.run(answer("invalid", ["Only one answer"]))).rejects.toThrow(
          "one answer per question",
        );
        const attempts = await Promise.allSettled([
          system.run(answer("first")),
          system.run(answer("duplicate")),
        ]);
        expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
        const rejected = attempts.find((attempt) => attempt.status === "rejected");
        expect(rejected?.status === "rejected" && String(rejected.reason)).toContain(
          "already been answered",
        );
        const answeredThread = (await system.run(engine.getReadModel())).threads[0]!;
        expect(
          answeredThread.messages.find((message) => message.id === questionId)?.updatedAt,
        ).toBe(createdAt);
        await system.run(completeQuestion()); // A replay must not reopen the answered card.
        const after = (await system.run(engine.getReadModel())).threads[0]!;
        const response = after.messages.find((message) => message.id === questionId)?.asyncUserInput
          ?.response;
        expect(response?.answers).toEqual(["On reconnect", "Only after sleep"]);
        const answers = after.messages.filter((message) => message.role === "user");
        expect(answers).toHaveLength(1);
        expect(answers[0]).toMatchObject({
          id: response?.messageId,
          text: "When does it happen?\nOn reconnect\n\nAny other details?\nOnly after sleep",
          dispatchMode: "steer",
          startsNewTurn: !running,
        });
        expect(after.runtimeMode).toBe("approval-required");
        expect(after.interactionMode).toBe("default");
        expect(after.session?.status).toBe(running ? "running" : "ready");
      } finally {
        await system.dispose();
      }
    },
  );

  it("keeps a second checkpoint revert protected after a failed revert with a higher runtime sequence", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const projectId = asProjectId("project-revert-sequence");
    const threadId = ThreadId.makeUnsafe("thread-revert-sequence");
    let commandIndex = 0;
    const commandId = () => CommandId.makeUnsafe(`revert-sequence-${++commandIndex}`);
    const appendActivity = (kind: string, sequence?: number) =>
      system.run(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId(),
          threadId,
          activity: {
            id: EventId.makeUnsafe(`revert-sequence-activity-${commandIndex}`),
            kind,
            tone: "info",
            summary: kind,
            payload: {},
            turnId: null,
            ...(sequence === undefined ? {} : { sequence }),
            createdAt,
          },
          createdAt,
        }),
      );
    const revert = () =>
      system.run(
        engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: commandId(),
          threadId,
          turnCount: 1,
          createdAt,
        }),
      );

    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: commandId(),
          projectId,
          title: "Checkpoint sequence",
          workspaceRoot: "/tmp/checkpoint-sequence",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: commandId(),
          threadId,
          projectId,
          title: "Checkpoint sequence",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await appendActivity("tool.completed", 1_000);
      await revert();
      await appendActivity("checkpoint.revert.failed");
      await revert();

      await expect(
        system.run(
          engine.dispatch({
            type: "thread.delete",
            commandId: commandId(),
            threadId,
          }),
        ),
      ).rejects.toThrow("checkpoint revert in progress");
      await expect(
        system.run(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: commandId(),
            threadId,
            message: {
              messageId: asMessageId("message-during-revert"),
              role: "user",
              text: "Continue",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt,
          }),
        ),
      ).rejects.toThrow("checkpoint revert in progress");
      await expect(revert()).rejects.toThrow("checkpoint revert in progress");
    } finally {
      await system.dispose();
    }
  });

  it("preserves large Unicode responses and segment boundaries through completion", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-large-response");
    const messageId = asMessageId("message-large-response");
    try {
      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("large-project"),
          projectId: asProjectId("large-project"),
          title: "Large response",
          workspaceRoot: "/tmp/large-response",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("large-thread"),
          threadId,
          projectId: asProjectId("large-project"),
          title: "Large response",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      // Each delta fits the journal budget, but their combined text exceeds
      // 512 KiB. Later output includes a surrogate pair split across deltas.
      const chunks = [
        "é漢😀".repeat(30_000),
        `${"é漢😀".repeat(30_000)}\nSecond segment \ud83d`,
        "\ude80 done",
      ];
      for (const [index, delta] of chunks.entries()) {
        await system.run(
          engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.makeUnsafe(`large-delta-${index}`),
            threadId,
            messageId,
            delta,
            ...(index < 2 ? { segmentStartedAt: createdAt, segmentSequence: index + 1 } : {}),
            createdAt,
          }),
        );
      }
      await system.run(
        engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("large-complete"),
          threadId,
          messageId,
          createdAt,
        }),
      );
      const expected = chunks.join("");
      const events = await system.run(Stream.runCollect(engine.readEvents(0)));
      const completed = Array.from(events).findLast(
        (event) => event.type === "thread.message-sent",
      );
      expect(completed?.payload).toMatchObject({ streaming: false, text: expected });
      const model = await system.run(engine.getReadModel());
      const message = model.threads.find((thread) => thread.id === threadId)?.messages[0];
      expect(message?.text).toBe(expected);
      expect(message?.textSegments?.map((segment) => segment.text)).toEqual([
        chunks[0],
        chunks.slice(1).join(""),
      ]);
    } finally {
      await system.dispose();
    }
  });

  it("quiesces normal admission while draining reserved lifecycle commands", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-engine-quiesce");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-engine-quiesce-project"),
        projectId: asProjectId("project-engine-quiesce"),
        title: "Engine quiesce",
        workspaceRoot: "/tmp/engine-quiesce",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-engine-quiesce-thread"),
        threadId,
        projectId: asProjectId("project-engine-quiesce"),
        title: "Engine quiesce thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await system.run(system.engine.quiesce);
    const diagnostic = {
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe("cmd-engine-quiesce-diagnostic"),
      threadId,
      activity: {
        id: EventId.makeUnsafe("engine-quiesce-diagnostic"),
        tone: "error",
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        payload: { detail: "Provider rejected the interrupt during shutdown." },
        turnId: null,
        createdAt,
      },
      createdAt,
    } as const;
    await expect(system.run(system.engine.dispatch(diagnostic))).resolves.toMatchObject({
      sequence: expect.any(Number),
    });
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-normal"),
          threadId,
          title: "Rejected after quiesce",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    // A turn start takes the priority `user` lane, but priority is not
    // admissibility: the WebSocket keeps serving while the engine quiesces, and
    // starting a provider turn here would spawn a session the shutdown fences
    // moments later, orphaning the turn.
    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-turn-start"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("msg-engine-quiesce-turn-start"),
            role: "user",
            text: "Rejected after quiesce",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("cmd-engine-quiesce-control"),
          threadId,
          createdAt,
        }),
      ),
    ).resolves.toMatchObject({ sequence: expect.any(Number) });
    await system.run(system.engine.drain);
    await system.run(system.engine.stop);

    await expect(
      system.run(
        system.engine.dispatch({
          ...diagnostic,
          commandId: CommandId.makeUnsafe("cmd-engine-stopped-diagnostic"),
        }),
      ),
    ).rejects.toMatchObject({ _tag: "OrchestrationCommandAdmissionError", reason: "stopped" });

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-engine-stopped-control"),
          threadId,
          createdAt,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandAdmissionError",
      reason: "stopped",
    });

    await system.dispose();
  });

  it("returns the original result for an equal retry and rejects unequal command-ID reuse", async () => {
    const system = await createOrchestrationSystem();
    const command = {
      type: "project.create" as const,
      commandId: CommandId.makeUnsafe("cmd-fingerprint-retry"),
      projectId: asProjectId("project-fingerprint-retry"),
      title: "Fingerprint project",
      workspaceRoot: "/tmp/project-fingerprint-retry",
      defaultModelSelection: null,
      createdAt: "2026-07-14T00:00:00.000Z",
    };

    const first = await system.run(system.engine.dispatch(command));
    await expect(system.run(system.engine.dispatch({ ...command }))).resolves.toEqual(first);
    await expect(
      system.run(
        system.engine.dispatch({
          ...command,
          title: "Different command content",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandIdentityCollisionError",
      commandId: command.commandId,
    });

    const events = await system.run(Stream.runCollect(system.engine.readEvents(0)));
    expect(Array.from(events)).toHaveLength(1);
    expect(
      Array.from(events).filter((event) => event.commandId === command.commandId),
    ).toHaveLength(1);
    expect((await system.run(system.engine.getReadModel())).projects[0]?.title).toBe(
      "Fingerprint project",
    );
    await system.dispose();
  });

  it("claims managed attachments atomically and rejects attachment changes on an accepted retry", async () => {
    const createdAt = now();
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const threadId = ThreadId.makeUnsafe("thread-managed-attachment");
    const commandId = CommandId.makeUnsafe("cmd-managed-attachment-turn");
    const messageId = asMessageId("msg-managed-attachment");
    const principal = { ownerKind: "session" as const, ownerId: "session-a" };

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-managed-attachment-project"),
        projectId: asProjectId("project-managed-attachment"),
        title: "Managed attachment project",
        workspaceRoot: "/tmp/project-managed-attachment",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-managed-attachment-thread"),
        threadId,
        projectId: asProjectId("project-managed-attachment"),
        title: "Managed attachment thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const repository = system.managedAttachmentRepository;
    const stage = async (attachmentId: string) => {
      const reserved = await system.run(
        repository.reserve({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          kind: "image",
          originalName: `${attachmentId}.png`,
          mimeType: "image/png",
          reservedBytes: 1,
          relativePath: `objects/aa/${attachmentId}.png`,
          now: createdAt,
        }),
      );
      expect(reserved.status).toBe("reserved");
      await system.run(
        repository.finalizeStaged({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          sizeBytes: 1,
          sha256: "a".repeat(64),
          stagingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          now: createdAt,
        }),
      );
    };
    const firstAttachmentId = "att_v2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const secondAttachmentId = "att_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await stage(firstAttachmentId);
    await stage(secondAttachmentId);

    const command = {
      type: "thread.turn.start" as const,
      commandId,
      threadId,
      message: {
        messageId,
        role: "user" as const,
        text: "inspect",
        attachments: [
          {
            type: "image" as const,
            id: firstAttachmentId,
            name: "client-value-is-not-authoritative.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };
    const accepted = await system.run(engine.dispatch(command, { attachmentPrincipal: principal }));
    await expect(
      system.run(engine.dispatch(command, { attachmentPrincipal: principal })),
    ).resolves.toEqual(accepted);

    await expect(system.run(engine.dispatch(command, { settleOnly: true }))).resolves.toEqual(
      accepted,
    );
    await expect(system.run(engine.dispatch(command))).rejects.toThrow(
      "different managed attachment set or owner",
    );

    const editResendClaim = await system.run(
      repository.claimForAcceptedTurn({
        attachmentIds: [firstAttachmentId],
        ownerThreadId: threadId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        commandId: "cmd-attachment-edit-resend",
        messageId,
        now: new Date().toISOString(),
      }),
    );
    expect(editResendClaim.status).toBe("claimed");
    await expect(
      system.run(engine.dispatch(command, { attachmentPrincipal: principal })),
    ).resolves.toEqual(accepted);

    await expect(
      system.run(
        engine.dispatch(
          {
            ...command,
            message: {
              ...command.message,
              attachments: [{ ...command.message.attachments[0]!, id: secondAttachmentId }],
            },
          },
          { attachmentPrincipal: principal },
        ),
      ),
    ).rejects.toThrow("Command identity collision");

    const claimed = await system.run(repository.findClaimedForCommand({ commandId }));
    expect(claimed.map((attachment) => attachment.attachmentId)).toEqual([firstAttachmentId]);
    await system.dispose();
  });

  it("keeps dispatch responsive and replays every event when a subscriber falls behind", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const projectId = asProjectId("project-slow-subscriber");
    // Overflow by more than one durable replay page (500 events).
    const count = ORCHESTRATION_EVENT_PUBSUB_CAPACITY + 510;
    try {
      const initial = await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-slow-subscriber-create"),
          projectId,
          title: "Slow subscriber",
          workspaceRoot: "/tmp/slow-subscriber",
          defaultModelSelection: null,
          createdAt: now(),
        }),
      );
      const result = await system.run(
        Effect.gen(function* () {
          // Attach before loading/processing work, as startup and reactors do.
          const live = yield* engine.subscribeDomainEvents;
          for (let i = 0; i < count; i++) {
            yield* engine.dispatch({
              type: "project.meta.update",
              commandId: CommandId.makeUnsafe(`cmd-slow-subscriber-${i}`),
              projectId,
              title: `Update ${i}`,
            });
          }
          return Array.from(yield* Stream.runCollect(Stream.take(live, count)));
        }).pipe(Effect.scoped, Effect.timeoutOption("8 seconds")),
      );
      expect(Option.isSome(result)).toBe(true);
      const events = Option.getOrThrow(result);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: count }, (_, i) => initial.sequence + i + 1),
      );
      expect(events.at(-1)?.payload).toMatchObject({ title: `Update ${count - 1}` });
    } finally {
      await system.dispose();
    }
  }, 15_000);

  it("materializes an oversized thread goal to a file and stores a read-file reference", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-goal-materialize");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-goal-materialize"),
        projectId: asProjectId("project-goal-materialize"),
        title: "Goal Materialize Project",
        workspaceRoot: "/tmp/project-goal-materialize",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-goal-materialize-create"),
        threadId,
        projectId: asProjectId("project-goal-materialize"),
        title: "goal-materialize",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const oversizedGoal = `Long-lived objective. ${"d".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-materialize-update"),
        threadId,
        goal: oversizedGoal,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.goal).toMatch(/^Read this file: /);
    const goalFilePath = thread?.goal?.replace("Read this file: ", "");
    expect(goalFilePath).toContain("thread-goals");
    await expect(fs.readFile(goalFilePath ?? "", "utf8")).resolves.toBe(oversizedGoal);

    // Edit goal exposes this exact reference. Saving it unchanged must retain
    // the objective even though the reference itself fits the inline budget.
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-materialize-save-reference"),
        threadId,
        goal: thread!.goal!,
      }),
    );
    await expect(fs.readFile(goalFilePath ?? "", "utf8")).resolves.toBe(oversizedGoal);

    // A second oversized goal gets its own file — the previous file is pruned
    // once the new reference commits, so the live file can never be clobbered.
    const supersedingGoal = `Replacement objective. ${"r".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-materialize-supersede"),
        threadId,
        goal: supersedingGoal,
      }),
    );
    const supersededThread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    const supersededPath = supersededThread?.goal?.replace("Read this file: ", "");
    expect(supersededPath).not.toBe(goalFilePath);
    await expect(fs.readFile(supersededPath ?? "", "utf8")).resolves.toBe(supersedingGoal);
    await expect(fs.access(goalFilePath ?? "")).rejects.toThrow();

    // Moving the goal back inline removes the thread's goal files.
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-materialize-inline"),
        threadId,
        goal: "Ship it",
      }),
    );
    expect(
      (await system.run(engine.getReadModel())).threads.find((entry) => entry.id === threadId)
        ?.goal,
    ).toBe("Ship it");
    await expect(fs.readdir(path.dirname(supersededPath ?? ""))).rejects.toThrow();

    await system.dispose();
  });

  it("removes the materialized goal file when the update is rejected before commit", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-goal-reject");
    const stateDir = system.stateDir;

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-goal-reject"),
        projectId: asProjectId("project-goal-reject"),
        title: "Goal Reject Project",
        workspaceRoot: "/tmp/project-goal-reject",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-goal-reject-create"),
        threadId,
        projectId: asProjectId("project-goal-reject"),
        title: "goal-reject",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    // The goal file is written before command invariants run: a stale title
    // sequence rejects the update after its candidate file already exists.
    const oversizedGoal = `Rejected objective. ${"x".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
    await expect(
      system.run(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-goal-reject"),
          threadId,
          goal: oversizedGoal,
          expectedTitleSequence: 9_999,
        }),
      ),
    ).rejects.toThrow("title changed");

    const goalRoot = path.join(stateDir, "thread-goals");
    const directories = await fs.readdir(goalRoot).catch(() => [] as string[]);
    const leftover = (
      await Promise.all(directories.map((dir) => fs.readdir(path.join(goalRoot, dir))))
    ).flat();
    expect(leftover).toEqual([]);
    expect(
      (await system.run(engine.getReadModel())).threads.find((entry) => entry.id === threadId)
        ?.goal,
    ).toBeUndefined();

    await system.dispose();
  });

  it("still commits the goal update when post-commit goal-file pruning fails", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-goal-prune-fail");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-goal-prune-fail"),
        projectId: asProjectId("project-goal-prune-fail"),
        title: "Goal Prune Fail Project",
        workspaceRoot: "/tmp/project-goal-prune-fail",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-goal-prune-fail-create"),
        threadId,
        projectId: asProjectId("project-goal-prune-fail"),
        title: "goal-prune-fail",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const firstGoal = `First objective. ${"a".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-prune-fail-first"),
        threadId,
        goal: firstGoal,
      }),
    );
    const firstPath = (await system.run(engine.getReadModel())).threads
      .find((entry) => entry.id === threadId)
      ?.goal?.replace("Read this file: ", "");

    // Pruning is best-effort: a rejection must be logged and contained, never
    // fail the committed command or strand the new reference.
    vi.mocked(pruneThreadGoalFiles).mockRejectedValueOnce(new Error("EACCES: locked"));
    const secondGoal = `Second objective. ${"b".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-prune-fail-second"),
        threadId,
        goal: secondGoal,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    const secondPath = thread?.goal?.replace("Read this file: ", "");
    expect(secondPath).not.toBe(firstPath);
    await expect(fs.readFile(secondPath ?? "", "utf8")).resolves.toBe(secondGoal);
    // The failed prune leaves the superseded file on disk rather than hiding it.
    await expect(fs.readFile(firstPath ?? "", "utf8")).resolves.toBe(firstGoal);

    await system.dispose();
  });

  it.each([
    ["goal:file", "goal_file"],
    ["cmd-A", "cmd-a"],
  ])(
    "keeps the committed goal file when %s is followed by rejected %s",
    async (acceptedId, rejectedId) => {
      const system = await createOrchestrationSystem();
      const { engine } = system;
      const createdAt = now();
      const threadId = ThreadId.makeUnsafe("thread-goal-collision");
      const projectId = asProjectId("project-goal-collision");

      await system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-goal-collision"),
          projectId,
          title: "Goal Collision Project",
          workspaceRoot: "/tmp/project-goal-collision",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-goal-collision-create"),
          threadId,
          projectId,
          title: "goal-collision",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );

      // Rejected candidates must not alias a committed file through either
      // punctuation encoding or filesystem case folding.
      const committedGoal = `Committed objective. ${"c".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
      await system.run(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(acceptedId),
          threadId,
          goal: committedGoal,
        }),
      );
      const committedThread = (await system.run(engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      const committedPath = committedThread?.goal?.replace("Read this file: ", "");
      await expect(fs.readFile(committedPath ?? "", "utf8")).resolves.toBe(committedGoal);

      await expect(
        system.run(
          engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(rejectedId),
            threadId,
            goal: `Rejected objective. ${"r".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`,
            expectedTitleSequence: 9_999,
          }),
        ),
      ).rejects.toThrow("title changed");

      await expect(fs.readFile(committedPath ?? "", "utf8")).resolves.toBe(committedGoal);
      await system.dispose();
    },
  );

  it("retains an accepted goal file when interruption leaves its receipt unreadable", async () => {
    const system = await createOrchestrationSystem();
    const { engine, sql, receiptRepository } = system;
    const threadId = ThreadId.makeUnsafe("thread-goal-uncertain");
    const projectId = asProjectId("project-goal-uncertain");
    const createdAt = now();
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-goal-uncertain-project"),
        projectId,
        title: "Uncertain goal",
        workspaceRoot: "/tmp/goal-uncertain",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-goal-uncertain-thread"),
        threadId,
        projectId,
        title: "Uncertain goal",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const commandId = CommandId.makeUnsafe("cmd-goal-uncertain-set");
    const goal = `Accepted objective. ${"g".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
    const originalTransaction = sql.withTransaction;
    const originalLookup = receiptRepository.getByCommandId;
    // Run the real SQLite commit, then interrupt before the engine records its
    // local commit flag. Only the cleanup lookup fails; receipt storage is real.
    const transaction = vi
      .spyOn(sql, "withTransaction")
      .mockImplementationOnce((effect) =>
        originalTransaction(effect).pipe(Effect.andThen(Effect.interrupt)),
      );
    const lookup = vi
      .spyOn(receiptRepository, "getByCommandId")
      .mockImplementationOnce(originalLookup)
      .mockImplementationOnce(() =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.cleanupReceipt",
            detail: "temporary receipt read failure",
            cause: new Error("temporary receipt read failure"),
          }),
        ),
      );
    try {
      const pending = system.run(
        engine
          .dispatch({ type: "thread.meta.update", commandId, threadId, goal })
          .pipe(Effect.timeoutOption("2 seconds")),
      );
      await pending;
      const receipt = await system.run(originalLookup({ commandId }));
      expect(Option.isSome(receipt) && receipt.value.status).toBe("accepted");
      const events = Array.from(await system.run(Stream.runCollect(engine.readEvents(0))));
      const persisted = events.find(
        (event) => event.commandId === commandId && event.type === "thread.meta-updated",
      );
      if (persisted?.type !== "thread.meta-updated")
        throw new Error("Accepted goal event missing.");
      expect(persisted.payload.goal).toMatch(/^Read this file: /);
      await expect(
        fs.readFile(persisted.payload.goal!.replace("Read this file: ", ""), "utf8"),
      ).resolves.toBe(goal);
    } finally {
      transaction.mockRestore();
      lookup.mockRestore();
      await system.dispose();
    }
  });

  it("records the full oversized goal text in the achievement when the goal completes", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const threadId = ThreadId.makeUnsafe("thread-goal-achieved");
    const projectId = asProjectId("project-goal-achieved");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-goal-achieved"),
        projectId,
        title: "Goal Achieved Project",
        workspaceRoot: "/tmp/project-goal-achieved",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-goal-achieved-create"),
        threadId,
        projectId,
        title: "goal-achieved",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const oversizedGoal = `Durable objective. ${"d".repeat(THREAD_GOAL_INLINE_MAX_CHARS)}`;
    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-achieved-set"),
        threadId,
        goal: oversizedGoal,
      }),
    );
    const beforeAchieve = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    const goalFilePath = beforeAchieve?.goal?.replace("Read this file: ", "");
    expect(goalFilePath).toContain("thread-goals");

    await system.run(
      engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-achieved-done"),
        threadId,
        goalAchieved: true,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    // The persisted goal was only a file reference; the achievement must hold
    // the real text because the post-commit prune drops the whole directory.
    expect(thread?.goalAchievements?.at(-1)?.goal).toBe(oversizedGoal);
    expect(thread?.goal ?? "").toBe("");
    await expect(fs.access(goalFilePath ?? "")).rejects.toThrow();

    await system.dispose();
  });

  it("stores completed checkpoint summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-turn-diff-create"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn Diff Project",
        workspaceRoot: "/tmp/project-turn-diff",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-turn-diff-create"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        projectId: asProjectId("project-turn-diff"),
        title: "Turn diff thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-complete"),
        threadId: ThreadId.makeUnsafe("thread-turn-diff"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: asCheckpointRef("refs/synara/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    const thread = (await system.run(engine.getReadModel())).threads.find(
      (entry) => entry.id === "thread-turn-diff",
    );
    expect(thread?.checkpoints).toEqual([
      {
        turnId: asTurnId("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: asCheckpointRef("refs/synara/checkpoints/thread-turn-diff/turn/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: createdAt,
      },
    ]);
    await system.dispose();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStoreShape = {
      append(event) {
        if (shouldFailFirstAppend && event.commandId === CommandId.makeUnsafe("cmd-flaky-1")) {
          shouldFailFirstAppend = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, flakyStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-flaky-create"),
        projectId: asProjectId("project-flaky"),
        title: "Flaky Project",
        workspaceRoot: "/tmp/project-flaky",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-flaky-1"),
          threadId: ThreadId.makeUnsafe("thread-flaky-fail"),
          projectId: asProjectId("project-flaky"),
          title: "flaky-fail",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-flaky-2"),
        threadId: ThreadId.makeUnsafe("thread-flaky-ok"),
        projectId: asProjectId("project-flaky"),
        title: "flaky-ok",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);
    await runtime.dispose();
  });

  it("rolls back all events for a multi-event command when projection fails mid-dispatch", async () => {
    let shouldFailRequestedProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailRequestedProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-turn-start-atomic") &&
          event.type === "thread.turn-start-requested"
        ) {
          shouldFailRequestedProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-atomic-create"),
        projectId: asProjectId("project-atomic"),
        title: "Atomic Project",
        workspaceRoot: "/tmp/project-atomic",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-atomic-create"),
        threadId: ThreadId.makeUnsafe("thread-atomic"),
        projectId: asProjectId("project-atomic"),
        title: "atomic",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const turnStartCommand = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("cmd-turn-start-atomic"),
      threadId: ThreadId.makeUnsafe("thread-atomic"),
      message: {
        messageId: asMessageId("msg-atomic-1"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt,
    };

    await expect(runtime.runPromise(engine.dispatch(turnStartCommand))).rejects.toThrow(
      "failed unexpectedly",
    );

    const eventsAfterFailure = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterFailure.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
    ]);
    expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(2);

    const retryResult = await runtime.runPromise(engine.dispatch(turnStartCommand));
    expect(retryResult.sequence).toBe(4);

    const eventsAfterRetry = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRetry.map((event) => event.type)).toEqual([
      "project.created",
      "thread.created",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(
      eventsAfterRetry.filter((event) => event.commandId === turnStartCommand.commandId),
    ).toHaveLength(2);

    await runtime.dispose();
  });

  it("keeps processing later commands after an unexpected worker defect", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldDieProjection = true;
    const defectiveProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: (event) => {
        if (
          shouldDieProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-project-defect-1")
        ) {
          shouldDieProjection = false;
          return Effect.die("projection defect");
        }
        return Effect.void;
      },
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, defectiveProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-1"),
          projectId: asProjectId("project-defect-1"),
          title: "Defective Project",
          workspaceRoot: "/tmp/project-defect-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-defect-2"),
          projectId: asProjectId("project-defect-2"),
          title: "Recovered Project",
          workspaceRoot: "/tmp/project-defect-2",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        sequence: expect.any(Number),
      }),
    );

    const eventsAfterRecovery = await runtime.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(eventsAfterRecovery.map((event) => event.commandId)).toEqual([
      CommandId.makeUnsafe("cmd-project-defect-1"),
      CommandId.makeUnsafe("cmd-project-defect-2"),
    ]);
    expect(eventsAfterRecovery.every((event) => event.type === "project.created")).toBe(true);

    await runtime.dispose();
  });

  it("reconciles in-memory state when append persists but projection fails", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;

    const nonTransactionalStore: OrchestrationEventStoreShape = {
      append(event) {
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } as StoredEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      getHighWaterSequence() {
        return Effect.succeed(events.at(-1)?.sequence ?? 0);
      },
      ...makeThreadEventReadMethods(events),
      readFromSequence(sequenceExclusive) {
        return Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Stream.fromIterable(events);
      },
    };

    let shouldFailProjection = true;
    const flakyProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: (event) => {
        if (
          shouldFailProjection &&
          event.commandId === CommandId.makeUnsafe("cmd-thread-meta-sync-fail")
        ) {
          shouldFailProjection = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.projection",
              detail: "projection failed",
            }),
          );
        }
        return Effect.void;
      },
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, flakyProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(Layer.succeed(OrchestrationEventStore, nonTransactionalStore)),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-sync-create"),
        projectId: asProjectId("project-sync"),
        title: "Sync Project",
        workspaceRoot: "/tmp/project-sync",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-sync-create"),
        threadId: ThreadId.makeUnsafe("thread-sync"),
        projectId: asProjectId("project-sync"),
        title: "sync-before",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-meta-sync-fail"),
          threadId: ThreadId.makeUnsafe("thread-sync"),
          title: "sync-after-failed-projection",
        }),
      ),
    ).rejects.toThrow("failed unexpectedly");

    const readModelAfterFailure = await runtime.runPromise(engine.getReadModel());
    const updatedThread = readModelAfterFailure.threads.find(
      (thread) => thread.id === "thread-sync",
    );
    expect(readModelAfterFailure.snapshotSequence).toBe(3);
    expect(updatedThread?.title).toBe("sync-after-failed-projection");

    await runtime.dispose();
  });

  it("loads authoritative pending interactions before expiring a side chat", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const projectId = asProjectId("project-sidechat-pending-expiry");
    const sourceThreadId = ThreadId.makeUnsafe("thread-sidechat-pending-source");
    const sidechatId = ThreadId.makeUnsafe("thread-sidechat-pending");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-sidechat-pending-project"),
        projectId,
        title: "Sidechat pending expiry",
        workspaceRoot: "/tmp/sidechat-pending-expiry",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-sidechat-pending-source"),
        threadId: sourceThreadId,
        projectId,
        title: "Source thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-sidechat-pending-create"),
        threadId: sidechatId,
        sourceThreadId,
        sidechatSourceThreadId: sourceThreadId,
        projectId,
        title: "Pending side chat",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [],
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-sidechat-pending-approval"),
        threadId: sidechatId,
        activity: {
          id: EventId.makeUnsafe("activity-sidechat-pending-approval"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: {
            requestId: "approval-sidechat-pending",
            requestKind: "command",
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      }),
    );

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.sidechat.expire",
          commandId: CommandId.makeUnsafe("cmd-sidechat-pending-expire"),
          threadId: sidechatId,
          expectedLastActivityAt: createdAt,
          expiredAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString(),
        }),
      ),
    ).rejects.toThrow("still has a pending interaction");

    await system.dispose();
  });

  it("keeps projection health healthy when optional cursors do not exist yet", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-health-fresh"),
        projectId: asProjectId("project-health-fresh"),
        title: "Fresh projection health",
        workspaceRoot: "/tmp/project-health-fresh",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    await system.run(system.engine.drain);
    await expect(system.run(system.engine.getProjectionCatchUpStatus)).resolves.toMatchObject({
      state: "healthy",
      missingProjectors: [],
    });

    await system.dispose();
  });

  it.each(["typed", "synchronous"] as const)(
    "retries projection bootstrap while idle after an ambiguous persisted commit (%s failure)",
    async (failureKind) => {
      const system = await createOrchestrationSystem();
      const originalBootstrap = system.projectionPipeline.bootstrap;
      let bootstrapCalls = 0;
      let recovered!: () => void;
      const recovery = new Promise<void>((resolve) => {
        recovered = resolve;
      });
      Object.assign(system.projectionPipeline, {
        bootstrap: Effect.suspend(() => {
          bootstrapCalls++;
          if (bootstrapCalls <= 2) {
            if (failureKind === "synchronous")
              throw new Error("transient synchronous bootstrap failure");
            return Effect.fail(
              new PersistenceSqlError({
                operation: "test.projectionBootstrap",
                detail: "transient bootstrap failure",
              }),
            );
          }
          return originalBootstrap.pipe(Effect.tap(() => Effect.sync(recovered)));
        }),
      });
      const originalTransaction = system.sql.withTransaction;
      const transaction = vi.spyOn(system.sql, "withTransaction").mockImplementationOnce((effect) =>
        originalTransaction(effect).pipe(
          Effect.andThen(
            Effect.fail(
              new PersistenceSqlError({
                operation: "test.ambiguousCommit",
                detail: "connection failed after the commit",
              }),
            ),
          ),
        ),
      );
      const command = {
        type: "project.create" as const,
        commandId: CommandId.makeUnsafe(`idle-reconcile-${failureKind}`),
        projectId: asProjectId(`idle-reconcile-${failureKind}`),
        title: "Idle recovery",
        workspaceRoot: `/tmp/idle-reconcile-${failureKind}`,
        defaultModelSelection: null,
        createdAt: now(),
      };
      try {
        await system.run(Effect.exit(system.engine.dispatch(command)));
        await Promise.race([
          recovery,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Recovery did not finish while idle")), 4000),
          ),
        ]);
        expect(bootstrapCalls).toBe(3);
        await vi.waitFor(async () =>
          expect(await system.run(system.engine.getProjectionCatchUpStatus)).toMatchObject({
            state: "healthy",
            inFlight: false,
            retryAttempts: 0,
            lastFailure: null,
            missingProjectors: [],
          }),
        );
        const receipt = Option.getOrThrow(
          await system.run(
            system.receiptRepository.getByCommandId({ commandId: command.commandId }),
          ),
        );
        expect(receipt.status).toBe("accepted");
        expect(await system.run(system.engine.dispatch(command))).toEqual({
          sequence: receipt.resultSequence,
        });
      } finally {
        transaction.mockRestore();
        Object.assign(system.projectionPipeline, { bootstrap: originalBootstrap });
        await system.dispose();
      }
    },
  );

  it("restores the repair backup when rebuilt projectors do not reach the captured fence", async () => {
    const nonAdvancingProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.void,
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
    };
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(
          Layer.succeed(OrchestrationProjectionPipeline, nonAdvancingProjectionPipeline),
        ),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const createdAt = now();

    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-repair-fence"),
        projectId: asProjectId("project-repair-fence"),
        title: "Repair Fence Project",
        workspaceRoot: "/tmp/project-repair-fence",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    const beforeRepair = await runtime.runPromise(engine.getReadModel());

    await expect(runtime.runPromise(engine.repairState())).rejects.toThrow(
      "did not reach captured event fence 1",
    );
    await expect(runtime.runPromise(engine.getReadModel())).resolves.toEqual(beforeRepair);

    await runtime.dispose();
  });

  it("coalesces concurrent projection repairs and skips an immediate repeat", async () => {
    let bootstrapCalls = 0;
    let repairBootstrapCalls = 0;
    let resolveBootstrapStarted: (() => void) | undefined;
    let releaseBootstrap: (() => void) | undefined;
    const bootstrapStarted = new Promise<void>((resolve) => {
      resolveBootstrapStarted = resolve;
    });
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    const blockingProjectionPipeline: OrchestrationProjectionPipelineShape = {
      bootstrap: Effect.sync(() => (bootstrapCalls += 1)).pipe(
        Effect.flatMap((call) => {
          if (call === 1) {
            return Effect.void;
          }
          repairBootstrapCalls += 1;
          resolveBootstrapStarted?.();
          return Effect.promise(() => bootstrapGate);
        }),
      ),
      projectMetadataEvent: () => Effect.void,
      projectEvent: () => Effect.void,
      projectHotEventInCurrentTransaction: () => Effect.void,
    };
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationProjectionPipeline, blockingProjectionPipeline)),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(SqlitePersistenceMemory),
        Layer.provideMerge(TestServerConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

    const firstRepair = runtime.runPromise(engine.repairState());
    await bootstrapStarted;
    const secondRepair = runtime.runPromise(engine.repairState());
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseBootstrap?.();

    const [firstSnapshot, secondSnapshot] = await Promise.all([firstRepair, secondRepair]);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(repairBootstrapCalls).toBe(1);

    await runtime.runPromise(engine.repairState());
    expect(repairBootstrapCalls).toBe(1);

    await runtime.dispose();
  });

  it("retires an empty existing project when re-adding the same workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-stale-create"),
        projectId: asProjectId("project-stale"),
        title: "Stale Project",
        workspaceRoot: "/tmp/readd-project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-readd-create"),
          projectId: asProjectId("project-readd"),
          title: "Readded Project",
          workspaceRoot: "/tmp/readd-project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).resolves.toEqual({ sequence: 3 });

    const readModel = await system.run(engine.getReadModel());
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-stale"))?.deletedAt,
    ).toBe(createdAt);
    expect(
      readModel.projects.find((project) => project.id === asProjectId("project-readd"))?.deletedAt,
    ).toBeNull();

    await system.dispose();
  });

  it("keeps rejecting a duplicate workspace root when the existing project has threads", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-active-create"),
        projectId: asProjectId("project-active"),
        title: "Active Project",
        workspaceRoot: "/tmp/active-project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-project-active-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-active"),
        projectId: asProjectId("project-active"),
        title: "active",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-active-duplicate-create"),
          projectId: asProjectId("project-active-duplicate"),
          title: "Active Duplicate",
          workspaceRoot: "/tmp/active-project",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects Studio and regular projects claiming each other's workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-studio-create"),
        projectId: asProjectId("project-cross-kind-studio"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-cross-kind-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-project-create"),
        projectId: asProjectId("project-cross-kind-app"),
        kind: "project",
        title: "App",
        workspaceRoot: "/tmp/synara-cross-kind-app",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    // Adding the Studio container's folder as a regular project must not create a second
    // active project on that root (the empty container would otherwise be silently retired).
    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-project-on-studio-root"),
          projectId: asProjectId("project-on-studio-root"),
          kind: "project",
          title: "Studio folder",
          workspaceRoot: "/tmp/synara-cross-kind-studio",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // Creating a Studio container on a root an existing regular project owns must fail too.
    await expect(
      system.run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-studio-on-project-root"),
          projectId: asProjectId("project-studio-on-project-root"),
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/tmp/synara-cross-kind-app",
          defaultModelSelection: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // Root moves are covered by the same cross-kind ownership rule.
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-project-root-update"),
          projectId: asProjectId("project-cross-kind-app"),
          workspaceRoot: "/tmp/synara-cross-kind-studio",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    // A kind-only update must not carry an existing pin onto a kind that can never be pinned.
    await system.run(
      engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-pin-app"),
        projectId: asProjectId("project-cross-kind-app"),
        isPinned: true,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-pinned-kind-change"),
          projectId: asProjectId("project-cross-kind-app"),
          kind: "studio",
          workspaceRoot: "/tmp/synara-cross-kind-pinned-studio",
        }),
      ),
    ).rejects.toThrow("Only projects can be pinned.");

    // A kind-only update must not bypass ownership either: a chat project sitting on an owned
    // root cannot become a workspace-owning kind without the root check running.
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-cross-kind-chat-create"),
        projectId: asProjectId("project-cross-kind-chat"),
        kind: "chat",
        title: "Home",
        workspaceRoot: "/tmp/synara-cross-kind-studio",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cross-kind-chat-kind-only-update"),
          projectId: asProjectId("project-cross-kind-chat"),
          kind: "studio",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects moving a Studio container onto another Studio workspace root", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-source-create"),
        projectId: asProjectId("project-studio-source"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio-source",
        defaultModelSelection: null,
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-studio-target-create"),
        projectId: asProjectId("project-studio-target"),
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/tmp/synara-studio-target",
        defaultModelSelection: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-studio-target-root-update"),
          projectId: asProjectId("project-studio-target"),
          workspaceRoot: "/tmp/synara-studio-source",
        }),
      ),
    ).rejects.toThrow("already uses workspace root");

    await system.dispose();
  });

  it("rejects duplicate thread creation", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-duplicate-create"),
        projectId: asProjectId("project-duplicate"),
        title: "Duplicate Project",
        workspaceRoot: "/tmp/project-duplicate",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-duplicate-1"),
        threadId: ThreadId.makeUnsafe("thread-duplicate"),
        projectId: asProjectId("project-duplicate"),
        title: "duplicate",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-duplicate-2"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          projectId: asProjectId("project-duplicate"),
          title: "duplicate",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already exists");

    await system.dispose();
  });

  it("keeps the worker alive when a command throws while its pipeline is built", async () => {
    const system = await createOrchestrationSystem();
    const createdAt = now();
    const poisonedCommandId = CommandId.makeUnsafe("cmd-engine-poison");
    fingerprintPoison.add(poisonedCommandId);

    try {
      const poisonedOutcome = await system.run(
        Effect.result(
          system.engine.dispatch({
            type: "project.create",
            commandId: poisonedCommandId,
            projectId: asProjectId("project-engine-poison"),
            title: "Poisoned",
            workspaceRoot: "/tmp/engine-poison",
            defaultModelSelection: null,
            createdAt,
          }),
        ).pipe(Effect.timeoutOption("5 seconds")),
      );

      // The defect fails this command immediately instead of leaving the caller to
      // wait out the dispatch timeout.
      expect(Option.isSome(poisonedOutcome)).toBe(true);
      const outcome = Option.getOrThrow(poisonedOutcome);
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toMatchObject({ _tag: "OrchestrationCommandInternalError" });
      }

      // The worker survived: the next command still runs.
      await expect(
        system.run(
          system.engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("cmd-engine-poison-next"),
            projectId: asProjectId("project-engine-poison-next"),
            title: "After poison",
            workspaceRoot: "/tmp/engine-poison-next",
            defaultModelSelection: null,
            createdAt,
          }),
        ),
      ).resolves.toMatchObject({ sequence: expect.any(Number) });

      // The poisoned envelope was still finished, so `outstanding` did not leak.
      const drained = await system.run(
        Effect.timeoutOption(system.engine.drain, "5 seconds").pipe(Effect.map(Option.isSome)),
      );
      expect(drained).toBe(true);
    } finally {
      fingerprintPoison.delete(poisonedCommandId);
      await system.dispose();
    }
  });
});
