// Proves the thread-detail snapshot contract the web client relies on: the
// snapshot's message text is exactly the streamed deltas at or below its
// `snapshotSequence`, never a delta from a later event. The client fences live
// deltas by that sequence, so any later delta inside the text would be applied
// twice.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive as OrchestrationProjectionSnapshotQueryBase } from "./ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const at = "2026-10-09T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("fence-thread");
const messageId = MessageId.makeUnsafe("fence-message");
const projectId = ProjectId.makeUnsafe("fence-project");

it("fences streamed deltas and rollback revisions with the projected detail", async () => {
  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(
        OrchestrationProjectionSnapshotQueryBase.pipe(
          Layer.provide(ServerSettingsService.layerTest()),
        ),
      ),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "synara-fence-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("fence-project"),
        projectId,
        title: "Fence",
        workspaceRoot: "/tmp/fence",
        defaultModelSelection: null,
        createdAt: at,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("fence-thread"),
        threadId,
        projectId,
        title: "Fence",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: at,
      }),
    );

    const deltas = Array.from({ length: 60 }, (_, index) => `chunk-${index};`);
    const sequenceByDelta = new Map<string, number>();
    const observed: Array<{ readonly snapshotSequence: number; readonly text: string }> = [];
    const progress = { writing: true };
    // Interleave detail reads with the delta writes the way a reconnecting
    // client's projection reads race a live stream.
    await Promise.all([
      (async () => {
        for (const [index, delta] of deltas.entries()) {
          const { sequence } = await runtime.runPromise(
            engine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: CommandId.makeUnsafe(`fence-delta-${index}`),
              threadId,
              messageId,
              delta,
              createdAt: at,
            }),
          );
          sequenceByDelta.set(delta, sequence);
        }
        progress.writing = false;
      })(),
      (async () => {
        while (progress.writing) {
          const snapshot = await runtime.runPromise(
            snapshots.getThreadDetailSnapshotById(threadId),
          );
          const detail = Option.getOrThrow(snapshot);
          observed.push({
            snapshotSequence: detail.snapshotSequence,
            text: detail.thread.messages.find((message) => message.id === messageId)?.text ?? "",
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })(),
    ]);

    expect(observed.length).toBeGreaterThan(1);
    expect(new Set(observed.map((entry) => entry.text)).size).toBeGreaterThan(1);
    for (const { snapshotSequence, text } of observed) {
      const expected = deltas
        .filter((delta) => (sequenceByDelta.get(delta) ?? Infinity) <= snapshotSequence)
        .join("");
      expect(text).toBe(expected);
    }

    const beforeRollback = Option.getOrThrow(
      await runtime.runPromise(snapshots.getThreadDetailSnapshotById(threadId)),
    );
    expect(beforeRollback.historyRevisionSequence).toBe(0);
    const rollback = await runtime.runPromise(
      engine.dispatch({
        type: "thread.conversation.rollback.complete",
        commandId: CommandId.makeUnsafe("fence-rollback"),
        threadId,
        messageId,
        numTurns: 1,
        createdAt: at,
      }),
    );
    const afterRollback = Option.getOrThrow(
      await runtime.runPromise(snapshots.getThreadDetailSnapshotById(threadId)),
    );
    expect(afterRollback.thread.messages).toEqual([]);
    expect(afterRollback.historyRevisionSequence).toBe(rollback.sequence);

    // A durable event can lead its projections. Its revision must not make old
    // detail look authoritative for a rollback that has not been applied yet.
    const eventStore = await runtime.runPromise(Effect.service(OrchestrationEventStore));
    const pendingRollback = await runtime.runPromise(
      eventStore.append({
        eventId: EventId.makeUnsafe("fence-unprojected-rollback"),
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, turnCount: 0 },
      }),
    );
    const pending = Option.getOrThrow(
      await runtime.runPromise(snapshots.getThreadDetailSnapshotById(threadId)),
    );
    expect(pending.snapshotSequence).toBeLessThan(pendingRollback.sequence);
    expect(pending.historyRevisionSequence).toBe(rollback.sequence);
  } finally {
    await runtime.dispose();
  }
});
