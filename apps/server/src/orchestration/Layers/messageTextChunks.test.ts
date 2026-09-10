import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const at = "2026-09-10T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("chunk-thread");
const messageId = MessageId.makeUnsafe("chunk-message");
const projectId = ProjectId.makeUnsafe("chunk-project");
async function openSystem(dir?: string) {
  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
      Layer.provideMerge(
        dir ? makeSqlitePersistenceLive(join(dir, "state.sqlite")) : SqlitePersistenceMemory,
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), dir ?? { prefix: "synara-text-chunks-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const repository = await runtime.runPromise(Effect.service(ProjectionThreadMessageRepository));
  const snapshot = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const pipeline = await runtime.runPromise(Effect.service(OrchestrationProjectionPipeline));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  return {
    runtime,
    engine,
    repository,
    snapshot,
    pipeline,
    sql,
    run,
    seed: async () => {
      await run(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("seed-project"),
          projectId,
          title: "Chunks",
          workspaceRoot: dir ?? "/tmp/chunks",
          defaultModelSelection: null,
          createdAt: at,
        }),
      );
      await run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("seed-thread"),
          threadId,
          projectId,
          title: "Chunks",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: at,
        }),
      );
    },
    delta: (id: string, delta: string, segmentSequence?: number) =>
      run(
        engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe(id),
          threadId,
          messageId,
          delta,
          ...(segmentSequence === undefined ? {} : { segmentSequence, segmentStartedAt: at }),
          createdAt: at,
        }),
      ),
    complete: () =>
      run(
        engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("complete"),
          threadId,
          messageId,
          createdAt: at,
        }),
      ),
  };
}

async function assertReaders(system: Awaited<ReturnType<typeof openSystem>>, text: string) {
  const { run, repository, snapshot } = system;
  const row = Option.getOrThrow(
    await run(repository.getByThreadAndMessageId({ threadId, messageId })),
  );
  expect(row.text).toBe(text);
  expect((await run(repository.listByThreadId({ threadId })))[0]?.text).toBe(text);
  expect(
    Option.getOrThrow(await run(snapshot.getThreadDetailById(threadId))).messages[0]?.text,
  ).toBe(text);
  expect(
    Option.getOrThrow(await run(snapshot.getThreadDetailForExportById(threadId))).messages[0]?.text,
  ).toBe(text);
  const full = await run(snapshot.getSnapshot());
  expect(full.threads.find((thread) => thread.id === threadId)?.messages[0]?.text).toBe(text);
  return row;
}

it("preserves split Unicode across segments, restart and completion in every reader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synara-chunk-restart-"));
  let system = await openSystem(dir);
  try {
    await system.seed();
    await system.delta("first", "é漢\u0000\ud83d", 101);
    await assertReaders(system, "é漢\u0000\ud83d");
    await system.runtime.dispose();
    system = await openSystem(dir);
    await assertReaders(system, "é漢\u0000\ud83d");
    await system.delta("second", "\ude80 tail", 303);
    const streaming = await assertReaders(system, "é漢\u0000🚀 tail");
    expect(streaming.textSegments?.map((segment) => [segment.sequence, segment.text])).toEqual([
      [101, "é漢\u0000\ud83d"],
      [303, "\ude80 tail"],
    ]);
    await system.complete();
    const completed = await assertReaders(system, "é漢\u0000🚀 tail");
    expect(completed.textSegments?.map((segment) => segment.text)).toEqual([
      "é漢\u0000\ud83d",
      "\ude80 tail",
    ]);
    expect(await system.run(system.sql`SELECT * FROM message_text_chunks`)).toEqual([]);
    await system.runtime.dispose();
    system = await openSystem(dir);
    await assertReaders(system, "é漢\u0000🚀 tail");
  } finally {
    await system.runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves an unmatched surrogate when a message completes and resumes", async () => {
  const system = await openSystem();
  try {
    await system.seed();
    await system.delta("first", "hello \ud83d");
    await system.complete();
    await assertReaders(system, "hello \ud83d");
    await system.delta("resume", "\ude80");
    await assertReaders(system, "hello 🚀");
  } finally {
    await system.runtime.dispose();
  }
});

it("completes an older resumed message outside the transcript window after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synara-old-chunk-message-"));
  let system = await openSystem(dir);
  try {
    await system.seed();
    await system.delta("old-first", "before restart ");
    await system.run(
      system.sql.withTransaction(
        Effect.gen(function* () {
          for (let index = 0; index < 2001; index += 1) {
            yield* system.repository.upsert({
              threadId,
              messageId: MessageId.makeUnsafe(`newer-${index}`),
              turnId: null,
              role: "user",
              text: "newer message",
              isStreaming: false,
              source: "native",
              sequence: 10_000 + index,
              createdAt: at,
              updatedAt: at,
            });
          }
        }),
      ),
    );
    expect(
      Option.getOrThrow(
        await system.run(system.snapshot.getThreadDetailById(threadId)),
      ).messages.some((message) => message.id === messageId),
    ).toBe(false);
    await system.runtime.dispose();
    system = await openSystem(dir);
    await system.delta("old-resume", "after restart");
    await system.complete();
    const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
    const completed = events.findLast((event) => event.type === "thread.message-sent");
    expect(completed?.payload).toMatchObject({
      text: "before restart after restart",
      streaming: false,
    });
    expect(
      Option.getOrThrow(
        await system.run(system.repository.getByThreadAndMessageId({ threadId, messageId })),
      ).text,
    ).toBe("before restart after restart");
  } finally {
    await system.runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects duplicate deltas before and after completion and retained-history rollback", async () => {
  const system = await openSystem();
  try {
    await system.seed();
    await system.delta("first", "first", 101);
    await system.delta("second", " second", 303);
    const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
    const deltas = events.filter((event) => event.type === "thread.message-sent");
    for (const event of deltas) await system.run(system.pipeline.projectEvent(event));
    await assertReaders(system, "first second");
    await system.complete();
    for (const event of deltas) await system.run(system.pipeline.projectEvent(event));
    await assertReaders(system, "first second");
    const prunedId = MessageId.makeUnsafe("pruned-user-message");
    await system.run(
      system.repository.upsert({
        threadId,
        messageId: prunedId,
        turnId: null,
        role: "user",
        text: "remove this turn",
        isStreaming: false,
        source: "native",
        sequence: 999,
        createdAt: at,
        updatedAt: at,
      }),
    );
    await system.run(
      system.pipeline.projectEvent({
        ...deltas[0]!,
        type: "thread.conversation-rolled-back",
        sequence: 1000,
        eventId: EventId.makeUnsafe("rollback-event"),
        payload: { threadId, messageId: prunedId, numTurns: 1, removedTurnIds: [] },
      }),
    );
    for (const event of deltas) await system.run(system.pipeline.projectEvent(event));
    await assertReaders(system, "first second");
  } finally {
    await system.runtime.dispose();
  }
});

it.each(["", "edited response"])(
  "handles explicit final replacement %j without duplicating chunks",
  async (replacement) => {
    const system = await openSystem();
    try {
      await system.seed();
      await system.delta("first", "first", 101);
      await system.delta("second", " second", 303);
      const event = Array.from(
        await system.run(Stream.runCollect(system.engine.readEvents(0))),
      ).findLast((event) => event.type === "thread.message-sent")!;
      const completion = {
        ...event,
        sequence: event.sequence + 1,
        payload: { ...event.payload, text: replacement, streaming: false },
      };
      await system.run(system.pipeline.projectEvent(completion));
      const message = await assertReaders(system, replacement || "first second");
      expect(message.textSegments?.length ?? 0).toBe(replacement ? 0 : 2);
      await system.run(system.pipeline.projectEvent(event));
      await assertReaders(system, replacement || "first second");
    } finally {
      await system.runtime.dispose();
    }
  },
);

it("preserves a legacy streaming prefix and cascades chunk deletion on hard purge", async () => {
  const system = await openSystem();
  try {
    await system.seed();
    const prefix = "legacy ".repeat(10_000);
    await system.run(
      system.repository.upsert({
        threadId,
        messageId,
        turnId: null,
        role: "assistant",
        text: prefix,
        isStreaming: true,
        source: "native",
        createdAt: at,
        updatedAt: at,
      }),
    );
    await system.delta("resume-legacy", "continued");
    await assertReaders(system, prefix + "continued");
    const physical = await system.run(
      system.sql<{
        text: string;
      }>`SELECT text FROM projection_thread_messages WHERE thread_id = ${threadId}`,
    );
    expect(physical[0]?.text).toBe("");
    await system.run(
      system.sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`,
    );
    expect(
      await system.run(system.sql`SELECT * FROM message_text_chunks WHERE thread_id = ${threadId}`),
    ).toEqual([]);
  } finally {
    await system.runtime.dispose();
  }
});

it("preserves cached text on completion when the projection message row is missing", async () => {
  const system = await openSystem();
  try {
    await system.seed();
    await system.delta("before-missing-projection", "Hello world");
    await system.run(
      system.sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId} AND message_id = ${messageId}`,
    );
    await system.complete();
    await assertReaders(system, "Hello world");
  } finally {
    await system.runtime.dispose();
  }
});
