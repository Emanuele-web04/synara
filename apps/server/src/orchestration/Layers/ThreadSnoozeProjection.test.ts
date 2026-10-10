import { CommandId, MessageId, ProjectId, ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const testLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "synara-snooze-projection-" }),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("durable thread snooze", (it) => {
  it.effect("preserves schedule and reminder through every snapshot surface", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const now = new Date().toISOString();
      const due = new Date(Date.now() - 1_000).toISOString();
      const threadId = ThreadId.makeUnsafe("durable-snooze-thread");
      const projectId = ProjectId.makeUnsafe("durable-snooze-project");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("snooze-project"),
        projectId,
        title: "Snooze",
        workspaceRoot: "/tmp/snooze-projection",
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("snooze-thread"),
        threadId,
        projectId,
        title: "Snooze",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const readSurfaces = () =>
        Effect.gen(function* () {
          return [
            (yield* query.getSnapshot()).threads.find((thread) => thread.id === threadId)!,
            (yield* query.getCommandReadModel()).threads.find((thread) => thread.id === threadId)!,
            (yield* query.getShellSnapshot()).threads.find((thread) => thread.id === threadId)!,
            Option.getOrThrow(yield* query.getThreadShellById(threadId)),
            Option.getOrThrow(yield* query.getThreadDetailById(threadId)),
            Option.getOrThrow(yield* query.getThreadDetailForExportById(threadId)),
          ];
        });
      for (const thread of yield* readSurfaces()) {
        assert.isNull(thread.snoozedUntil);
        assert.isNull(thread.snoozeReminderAt);
      }
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("snooze-schedule"),
        threadId,
        snoozedUntil: due,
        isSettled: true,
      });
      for (const thread of yield* readSurfaces()) {
        assert.strictEqual(thread.snoozedUntil, due);
        assert.isNull(thread.snoozeReminderAt);
      }
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("snooze-expire"),
        threadId,
        snoozedUntil: null,
        expectedSnoozedUntil: due,
      });
      for (const thread of yield* readSurfaces()) {
        assert.isNull(thread.snoozedUntil);
        assert.isString(thread.snoozeReminderAt);
        assert.isNull(thread.settledAt);
      }
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("snooze-cancel"),
        threadId,
        snoozedUntil: null,
      });
      for (const thread of yield* readSurfaces()) assert.isNull(thread.snoozeReminderAt);
      const future = new Date(Date.now() + 3_600_000).toISOString();
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("snooze-before-human-turn"),
        threadId,
        snoozedUntil: future,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("snooze-human-turn"),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("snooze-human-message"),
          role: "user",
          text: "Resume",
          attachments: [],
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        createdAt: now,
      });
      for (const thread of yield* readSurfaces()) {
        assert.isNull(thread.snoozedUntil);
        assert.isNull(thread.snoozeReminderAt);
      }
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("snooze-before-archive"),
        threadId,
        snoozedUntil: future,
      });
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("snooze-archive"),
        threadId,
      });
      for (const thread of yield* readSurfaces()) {
        assert.isNull(thread.snoozedUntil);
        assert.isNull(thread.snoozeReminderAt);
      }
      yield* pipeline.bootstrap;
      for (const thread of yield* readSurfaces()) assert.isNull(thread.snoozedUntil);
    }),
  );
});
