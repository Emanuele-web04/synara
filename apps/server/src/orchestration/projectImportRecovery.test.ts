import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, DEFAULT_SERVER_SETTINGS, MessageId } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
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
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";
import { makeProjectImportHandlers } from "./projectImportRoute";
import {
  resolveProjectImportSources,
  resolveProjectImportSourceHome,
} from "./projectImportSources";
import { ServerSettingsService } from "../serverSettings.ts";

function makeRuntime() {
  return ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "synara-project-import-recovery-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}

it.each(["pending", "completed"] as const)(
  "recovers a deleted %s import with durable reservations and command receipts",
  async (status) => {
    const runtime = makeRuntime();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(makeProjectImportRepository);
      const createdAt = "2026-09-16T00:00:00.000Z";
      const readHistory = vi.fn(({ threadId }: { threadId: string }) =>
        Effect.succeed({
          nextCursor: null,
          messages: [
            {
              messageId: MessageId.makeUnsafe(`import:${threadId}:message`),
              role: "user" as const,
              text: "Original conversation",
              createdAt,
              updatedAt: createdAt,
            },
          ],
        }),
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
        // fail after durable message and archive commands were already accepted
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
      // reload the command model from SQLite, as a server restart does
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

it.each(["codex", "claudeAgent"] as const)(
  "keeps %s older pages durable and read-only across retries and restarts",
  async (provider) => {
    const runtime = makeRuntime();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(makeProjectImportRepository);
      const source = resolveProjectImportSources(DEFAULT_SERVER_SETTINGS, [provider])[0]!;
      const sourceHome = await resolveProjectImportSourceHome(source);
      const createdAt = "2026-09-16T00:00:00.000Z";
      const readHistory = vi.fn(({ threadId, cursor }: { threadId: string; cursor?: string }) =>
        Effect.succeed({
          nextCursor: cursor === "oldest" ? null : cursor === "older" ? "oldest" : "older",
          messages: [
            {
              messageId: MessageId.makeUnsafe(`import:${threadId}:${cursor ?? "recent"}`),
              role: "assistant" as const,
              text: cursor ?? "recent",
              createdAt,
              updatedAt: createdAt,
            },
          ],
        }),
      );
      const options = {
        repository,
        orchestrationEngine: engine,
        providerService: {
          importExternalThread: ({ threadId }: { threadId: string }) =>
            Effect.succeed({
              threadId,
              resumeCursor:
                provider === "codex" ? { threadId: "frozen-copy" } : { resume: "frozen-copy" },
            }),
          stopRuntimeSession: () => Effect.void,
        } as unknown as ProviderServiceShape,
        providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        discover: async () => ({
          sourceHome,
          projects: [{ id: "source", title: "Source", roots: [process.cwd()] }],
          sessions: [
            {
              id: "original",
              projectId: "source",
              title: "Original",
              cwd: process.cwd(),
              createdAt,
              updatedAt: createdAt,
              archived: false,
            },
          ],
        }),
        readHistory,
      };
      const handlers = makeProjectImportHandlers(options);
      const project = (
        await runtime.runPromise(handlers.listProjectImports({ providers: [provider] }))
      ).projects[0]!;
      const imported = await runtime.runPromise(
        handlers.importProject({ projectKey: project.key, threadKey: project.threads[0]!.key }),
      );
      const threadId = imported.threadId!;
      expect(await runtime.runPromise(handlers.loadProjectImportHistory({ threadId }))).toEqual({
        nextCursor: "1",
        messages: [],
      });
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const before = await runtime.runPromise(query.getThreadDetailById(threadId));
      const save = repository.saveHistory;
      repository.saveHistory = (state) =>
        state.revision === 2 ? Effect.die("interrupted page boundary") : save(state);
      await expect(
        runtime.runPromise(handlers.loadProjectImportHistory({ threadId, cursor: "1" })),
      ).rejects.toThrow("interrupted page boundary");
      repository.saveHistory = save;
      // Recreate handlers and rehydrate the model, preserving only durable state.
      await runtime.runPromise(engine.refreshCommandReadModel());
      const restarted = makeProjectImportHandlers(options);
      const older = await runtime.runPromise(
        restarted.loadProjectImportHistory({ threadId, cursor: "1" }),
      );
      expect(older).toMatchObject({ nextCursor: "2", messages: [{ text: "older" }] });
      expect(readHistory).toHaveBeenCalledTimes(2);
      const oldest = await runtime.runPromise(
        restarted.loadProjectImportHistory({ threadId, cursor: "2" }),
      );
      expect(oldest).toMatchObject({ nextCursor: null, messages: [{ text: "oldest" }] });
      // Reloading an earlier cached page cannot erase a later cached page.
      expect(
        await runtime.runPromise(restarted.loadProjectImportHistory({ threadId, cursor: "1" })),
      ).toEqual(older);
      expect(
        await runtime.runPromise(restarted.loadProjectImportHistory({ threadId, cursor: "2" })),
      ).toEqual(oldest);
      expect(readHistory).toHaveBeenCalledTimes(3);
      expect(await runtime.runPromise(query.getThreadDetailById(threadId))).toEqual(before);
      expect(await runtime.runPromise(restarted.loadProjectImportHistory({ threadId }))).toEqual({
        nextCursor: "1",
        messages: [],
      });
    } finally {
      await runtime.dispose();
    }
  },
);

it.each([
  { provider: "codex" as const, persisted: 100 },
  { provider: "codex" as const, persisted: 140 },
  { provider: "claudeAgent" as const, persisted: 100 },
  { provider: "claudeAgent" as const, persisted: 140 },
])(
  "finishes a legacy interrupted $provider import with $persisted persisted messages",
  async ({ provider, persisted }) => {
    const runtime = makeRuntime();
    try {
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      const repository = await runtime.runPromise(makeProjectImportRepository);
      const source = resolveProjectImportSources(DEFAULT_SERVER_SETTINGS, [provider])[0]!;
      const sourceHome = await resolveProjectImportSourceHome(source);
      const createdAt = "2026-09-16T00:00:00.000Z";
      const messages = (threadId: string, start: number, end: number) =>
        Array.from({ length: end - start }, (_, index) => ({
          messageId: MessageId.makeUnsafe(`import:${threadId}:${provider}:${start + index}`),
          role: "assistant" as const,
          text: `Original message ${start + index}`,
          // Undated native records get page-local fallback dates.
          createdAt: new Date(Date.parse(createdAt) + index).toISOString(),
          updatedAt: new Date(Date.parse(createdAt) + index).toISOString(),
        }));
      const readHistory = vi.fn(({ threadId, cursor }: { threadId: string; cursor?: string }) => {
        const end = cursor === undefined ? 140 : Number(cursor);
        const start = Math.max(0, end - 20);
        return Effect.succeed({
          messages: messages(threadId, start, end),
          nextCursor: start === 0 ? null : String(start),
        });
      });
      const options = {
        repository,
        orchestrationEngine: engine,
        providerService: {
          importExternalThread: ({ threadId }: { threadId: string }) =>
            Effect.succeed({
              threadId,
              resumeCursor: provider === "codex" ? { threadId: "copy" } : { resume: "copy" },
            }),
          stopRuntimeSession: () => Effect.void,
        } as unknown as ProviderServiceShape,
        providerAdapterRegistry: {} as ProviderAdapterRegistryShape,
        serverSettings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        } as unknown as ServerSettingsShape,
        discover: async () => ({
          sourceHome,
          projects: [{ id: "source", title: "Source", roots: [process.cwd()] }],
          sessions: [
            {
              id: "original",
              projectId: "source",
              title: "Original",
              cwd: process.cwd(),
              createdAt,
              updatedAt: createdAt,
              archived: false,
            },
          ],
        }),
        readHistory,
      };
      const handlers = makeProjectImportHandlers(options);
      const project = (
        await runtime.runPromise(handlers.listProjectImports({ providers: [provider] }))
      ).projects[0]!;
      const input = { projectKey: project.key, threadKey: project.threads[0]!.key };
      readHistory.mockReturnValueOnce(Effect.die("old server interrupted before history"));
      await expect(runtime.runPromise(handlers.importProject(input))).rejects.toThrow(
        "old server interrupted",
      );
      const origin = (await runtime.runPromise(repository.find(input.threadKey)))!;
      // The old importer committed its first 100 messages before interruption.
      // Use the real engine so SQLite owns the receipt and projected message rows.
      for (let offset = 0; offset < persisted; offset += 100) {
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.messages.import",
            commandId: CommandId.makeUnsafe(`project-import:${origin.threadId}:messages:${offset}`),
            threadId: origin.threadId,
            messages: messages(origin.threadId, offset, Math.min(offset + 100, persisted)).map(
              (message, index) => ({
                ...message,
                text: `Persisted full message ${offset + index}`,
                createdAt: new Date(Date.parse(createdAt) + offset + index).toISOString(),
              }),
            ),
            createdAt,
          }),
        );
      }
      await runtime.runPromise(engine.refreshCommandReadModel());
      const restarted = makeProjectImportHandlers(options);
      await runtime.runPromise(restarted.listProjectImports({ providers: [provider] }));
      const complete = repository.complete;
      repository.complete = vi
        .fn(complete)
        .mockReturnValueOnce(Effect.die("interrupted completion"));
      await expect(runtime.runPromise(restarted.importProject(input))).rejects.toThrow(
        "interrupted completion",
      );
      await runtime.runPromise(engine.refreshCommandReadModel());
      await runtime.runPromise(restarted.importProject(input));
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const detail = await runtime.runPromise(query.getThreadDetailById(origin.threadId));
      expect(Option.getOrThrow(detail).messages.map((message) => message.text)).toEqual(
        Array.from(
          { length: 140 },
          (_, index) => `${index < persisted ? "Persisted full" : "Original"} message ${index}`,
        ),
      );
      expect(
        await runtime.runPromise(restarted.loadProjectImportHistory({ threadId: origin.threadId })),
      ).toEqual({ messages: [], nextCursor: null });
    } finally {
      await runtime.dispose();
    }
  },
);
