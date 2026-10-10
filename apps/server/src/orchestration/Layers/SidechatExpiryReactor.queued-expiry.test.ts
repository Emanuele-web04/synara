import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ThreadId } from "@synara/contracts";
import { SIDECHAT_INACTIVITY_EXPIRY_MS } from "@synara/shared/sidechatExpiry";
import { Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

it.each(["never", "24h"] as const)(
  "does not persist an already-admitted one-hour expiry after changing the window to %s",
  async (sidechatExpiry) => {
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "synara-expiry-queue-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const release = Effect.runSync(Deferred.make<void>());
    let heldTransaction: Promise<void> | undefined;
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const settings = await runtime.runPromise(Effect.service(ServerSettingsService));
      const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      const projectId = ProjectId.makeUnsafe("project-expiry-queue");
      const sourceId = ThreadId.makeUnsafe("source-expiry-queue");
      const sidechatId = ThreadId.makeUnsafe("sidechat-expiry-queue");
      const activityAt = new Date(Date.now() - SIDECHAT_INACTIVITY_EXPIRY_MS - 1_000).toISOString();
      const commandId = () => CommandId.makeUnsafe(crypto.randomUUID());
      await runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: commandId(),
          projectId,
          title: "Expiry queue",
          workspaceRoot: "/tmp/expiry-queue",
          createdAt: activityAt,
        }),
      );
      const threadFields = {
        projectId,
        title: "Expiry queue",
        modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        interactionMode: "default" as const,
        runtimeMode: "approval-required" as const,
        branch: null,
        worktreePath: null,
        createdAt: activityAt,
      };
      await runtime.runPromise(
        engine.dispatch({
          ...threadFields,
          type: "thread.create",
          commandId: commandId(),
          threadId: sourceId,
        }),
      );
      await runtime.runPromise(
        engine.dispatch({
          ...threadFields,
          type: "thread.fork.create",
          commandId: commandId(),
          threadId: sidechatId,
          sourceThreadId: sourceId,
          sidechatSourceThreadId: sourceId,
          envMode: "local",
          importedMessages: [],
        }),
      );
      const expire = () => ({
        type: "thread.sidechat.expire" as const,
        commandId: commandId(),
        threadId: sidechatId,
        expectedLastActivityAt: activityAt,
        expiredAt: new Date().toISOString(),
      });

      // Hold the real SQLite connection so the engine worker waits on the
      // command ahead of expiry. Nothing mocks receipt admission or persistence.
      const locked = Effect.runSync(Deferred.make<void>());
      heldTransaction = runtime.runPromise(
        sql.withTransaction(
          Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      await Effect.runPromise(Deferred.await(locked));
      const preceding = runtime.runPromise(
        engine.dispatch({
          type: "project.meta.update",
          commandId: commandId(),
          projectId,
          title: "Queued metadata",
        }),
      );
      const queuedExpiry = runtime.runPromise(Effect.result(engine.dispatch(expire())));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await runtime.runPromise(settings.updateSettings({ sidechatExpiry }));
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await heldTransaction;
      await preceding;
      const outcome = await queuedExpiry;
      const persisted = await runtime.runPromise(Stream.runCollect(engine.readEvents(0)));
      expect(persisted.filter((event) => event.type === "thread.sidechat-expired")).toEqual([]);
      expect(
        (await runtime.runPromise(engine.getReadModel())).threads.find(
          (thread) => thread.id === sidechatId,
        )?.sidechatExpiredAt,
      ).toBeNull();

      expect(outcome._tag).toBe("Failure");

      // A subsequent one-hour setting admits fresh expiry; the rejected old
      // request cannot poison later commands or their durable receipts.
      await runtime.runPromise(settings.updateSettings({ sidechatExpiry: "1h" }));
      await runtime.runPromise(engine.dispatch(expire()));
      expect(
        (await runtime.runPromise(engine.getReadModel())).threads.find(
          (thread) => thread.id === sidechatId,
        )?.sidechatExpiredAt,
      ).not.toBeNull();
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await heldTransaction;
      await runtime.dispose();
    }
  },
);
