import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DEFAULT_SERVER_SETTINGS, MessageId } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { ServerConfig } from "../config";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeProjectImportRepository } from "../persistence/projectImportRepository";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";
import { makeProjectImportHandlers } from "./projectImportRoute";

it.each(["pending", "completed"] as const)(
  "recovers a deleted %s import with durable reservations and command receipts",
  async (status) => {
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "synara-project-import-recovery-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(makeProjectImportRepository);
      const createdAt = "2026-09-16T00:00:00.000Z";
      const readHistory = vi.fn(({ threadId }: { threadId: string }) =>
        Effect.succeed([
          {
            messageId: MessageId.makeUnsafe(`import:${threadId}:message`),
            role: "user" as const,
            text: "Original conversation",
            createdAt,
            updatedAt: createdAt,
          },
        ]),
      );
      const copy = vi.fn(({ threadId }: { threadId: string }) =>
        Effect.succeed({ threadId, resumeCursor: { threadId: `copy:${threadId}` } }),
      );
      const handlers = makeProjectImportHandlers({
        repository,
        orchestrationEngine: engine,
        providerService: {
          importExternalThread: copy,
          stopRuntimeSession: () => Effect.void,
        } as unknown as ProviderServiceShape,
        providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        discover: async () => ({
          sourceHome: "/codex",
          projects: [{ id: "source-project", title: "Source project", roots: [process.cwd()] }],
          sessions: [
            {
              id: "source-thread",
              projectId: "source-project",
              title: "Source conversation",
              cwd: process.cwd(),
              createdAt,
              updatedAt: createdAt,
              archived: true,
            },
          ],
        }),
        readHistory,
      });
      const preview = () =>
        runtime.runPromise(handlers.listProjectImports({ providers: ["codex"] }));
      const project = (await preview()).projects[0]!;
      const input = { projectKey: project.key, threadKey: project.threads[0]!.key };
      if (status === "pending") {
        // Fail after durable message and archive commands have already been accepted.
        const complete = repository.complete;
        repository.complete = vi
          .fn(complete)
          .mockReturnValueOnce(Effect.die("interrupted completion"));
        await expect(runtime.runPromise(handlers.importProject(input))).rejects.toThrow(
          "interrupted completion",
        );
      } else {
        await runtime.runPromise(handlers.importProject(input));
      }
      const original = (await runtime.runPromise(repository.find(input.threadKey)))!;
      expect(original.status).toBe(status);
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: original.threadId,
        }),
      );
      // Reload the command model from SQLite, as happens when the server restarts.
      await runtime.runPromise(engine.refreshCommandReadModel());
      expect((await preview()).projects[0]!.threads[0]!.alreadyImported).toBe(false);

      const replacement = await runtime.runPromise(handlers.importProject(input));

      expect(replacement.status).toBe("imported");
      expect(replacement.threadId).not.toBe(original.threadId);
      expect(copy).toHaveBeenCalledTimes(2);
      expect(await runtime.runPromise(repository.find(input.threadKey))).toMatchObject({
        threadId: replacement.threadId,
        status: "completed",
      });
      const active = (await runtime.runPromise(engine.getReadModel())).threads.filter(
        (thread) => thread.deletedAt === null,
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.messages.map((message) => message.text)).toEqual(["Original conversation"]);
      expect(active[0]?.archivedAt).not.toBeNull();
      expect((await preview()).projects[0]!.threads[0]!.alreadyImported).toBe(true);
      await expect(runtime.runPromise(handlers.importProject(input))).resolves.toMatchObject({
        threadId: replacement.threadId,
        status: "already-present",
      });
    } finally {
      await runtime.dispose();
    }
  },
);
