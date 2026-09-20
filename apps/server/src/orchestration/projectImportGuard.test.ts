import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../config";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { makeProjectImportRepository } from "../persistence/projectImportRepository";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine";

it("preserves an empty existing project and refuses turns until the native import is complete", async () => {
  const runtime = ManagedRuntime.make(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "synara-project-import-guard-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  try {
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const repository = await runtime.runPromise(makeProjectImportRepository);
    const projectId = ProjectId.makeUnsafe("project");
    const threadId = ThreadId.makeUnsafe("thread");
    const createdAt = "2026-09-16T00:00:00.000Z";
    const commandId = () => CommandId.makeUnsafe(crypto.randomUUID());
    await runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: commandId(),
        projectId,
        title: "Original title",
        workspaceRoot: "/tmp/project-import-guard",
        createdAt,
      }),
    );
    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: commandId(),
          projectId: ProjectId.makeUnsafe("replacement"),
          title: "Replacement",
          workspaceRoot: "/tmp/project-import-guard",
          preserveExistingProject: true,
          createdAt,
        }),
      ),
    ).rejects.toThrow("already uses workspace root");
    expect(
      (await runtime.runPromise(engine.getReadModel())).projects
        .filter((project) => project.deletedAt === null)
        .map((project) => project.title),
    ).toEqual(["Original title"]);
    await runtime.runPromise(
      repository.reserve({
        sourceKey: "source",
        provider: "codex",
        sourceHome: "/codex",
        externalId: "external",
        projectId,
        threadId,
        status: "pending",
        createdAt,
      }),
    );
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: commandId(),
        threadId,
        projectId,
        title: "Importing",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    const send = () =>
      engine.dispatch({
        type: "thread.turn.start",
        commandId: commandId(),
        threadId,
        interactionMode: "default",
        runtimeMode: "approval-required",
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        createdAt,
      });
    await expect(runtime.runPromise(send())).rejects.toThrow("still being imported");
    expect((await runtime.runPromise(engine.getReadModel())).threads[0]?.messages).toHaveLength(0);
    await runtime.runPromise(repository.complete("source"));
    await runtime.runPromise(send());
    expect((await runtime.runPromise(engine.getReadModel())).threads[0]?.messages).toHaveLength(1);
  } finally {
    await runtime.dispose();
  }
});
