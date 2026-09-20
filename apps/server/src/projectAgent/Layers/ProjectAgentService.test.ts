import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  ProjectId,
  ProjectTaskId,
  ThreadId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectAgentService } from "../Services/ProjectAgentService.ts";
import { ProjectAgentServiceLive } from "./ProjectAgentService.ts";

const groupId = ProjectId.makeUnsafe("project-group-1");
const ordinaryId = ProjectId.makeUnsafe("project-ordinary-1");
const studioId = ProjectId.makeUnsafe("project-studio-1");
const modelSelection = { provider: "codex" as const, model: "gpt-5-codex" };
const dispatched: OrchestrationCommand[] = [];

const snapshotLayer = Layer.effect(
  ProjectionSnapshotQuery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return {
      getProjectShellById: (projectId: ProjectId) => {
        if (projectId === groupId) {
          return Effect.succeed(
            Option.some({
              id: groupId,
              kind: "group" as const,
              title: "Alpha",
              workspaceRoot: `${config.groupsWorkspaceRoot}/alpha`,
              defaultModelSelection: null,
              scripts: [],
              isPinned: false,
              spaceId: null,
              createdAt: "2026-09-20T00:00:00.000Z",
              updatedAt: "2026-09-20T00:00:00.000Z",
            }),
          );
        }
        if (projectId === studioId) {
          return Effect.succeed(
            Option.some({
              id: studioId,
              kind: "studio" as const,
              title: "Studio",
              workspaceRoot: config.studioWorkspaceRoot,
              defaultModelSelection: null,
              scripts: [],
              isPinned: false,
              spaceId: null,
              createdAt: "2026-09-20T00:00:00.000Z",
              updatedAt: "2026-09-20T00:00:00.000Z",
            }),
          );
        }
        if (projectId === ordinaryId) {
          return Effect.succeed(
            Option.some({
              id: ordinaryId,
              kind: "project" as const,
              title: "App",
              workspaceRoot: "/tmp/app",
              defaultModelSelection: null,
              scripts: [],
              isPinned: false,
              spaceId: null,
              createdAt: "2026-09-20T00:00:00.000Z",
              updatedAt: "2026-09-20T00:00:00.000Z",
            }),
          );
        }
        return Effect.succeed(Option.none());
      },
    } as unknown as ProjectionSnapshotQuery["Service"];
  }),
);

const orchestrationLayer = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command: OrchestrationCommand) =>
    Effect.sync(() => {
      dispatched.push(command);
    }),
} as unknown as OrchestrationEngineService["Service"]);

const automationLayer = Layer.succeed(AutomationService, {
  createProjectManaged: () =>
    Effect.succeed({
      id: AutomationId.makeUnsafe("automation-1"),
    }),
  list: () => Effect.succeed({ definitions: [], runs: [] }),
  update: () => Effect.succeed({ id: AutomationId.makeUnsafe("automation-1"), prompt: "" }),
} as unknown as AutomationService["Service"]);

const testLayer = ProjectAgentServiceLive.pipe(
  Layer.provide(snapshotLayer),
  Layer.provide(orchestrationLayer),
  Layer.provide(automationLayer),
  Layer.provide(Layer.succeed(TextGeneration, {} as unknown as TextGeneration["Service"])),
  Layer.provide(
    Layer.succeed(ProjectionThreadRepository, {
      listByProjectId: () => Effect.succeed([]),
    } as unknown as ProjectionThreadRepository["Service"]),
  ),
  Layer.provide(ProjectAgentRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pa-group-" })),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(testLayer);

layer("ProjectAgentService groups", (it) => {
  it.effect("configures a group and imports exactly one greeting", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const service = yield* ProjectAgentService;
      const overview = yield* service.configure(
        {
          requestId: "req-group-1",
          projectId: groupId,
          coordinatorModelSelection: modelSelection,
          userDisplayName: "Dilip",
          goal: "Ship groups",
          icon: "folder",
          autoMemoryEnabled: true,
        },
        { kind: "user" },
      );
      assert.equal(overview.configured, true);
      assert.equal(overview.config?.goal, "Ship groups");
      assert.equal(overview.config?.icon, "folder");
      assert.equal(overview.config?.autoMemoryEnabled, true);
      const imported = dispatched.filter((command) => command.type === "thread.messages.import");
      assert.equal(imported.length, 1);
      if (imported[0]?.type === "thread.messages.import") {
        assert.equal(imported[0].messages.length, 1);
        assert.equal(imported[0].messages[0]?.role, "assistant");
        assert.equal(
          imported[0].messages[0]?.text.includes("Hi Dilip, welcome to your new group."),
          true,
        );
      }
    }),
  );

  it.effect("replays the same requestId without importing another greeting", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const service = yield* ProjectAgentService;
      yield* service.configure(
        {
          requestId: "req-group-1",
          projectId: groupId,
          coordinatorModelSelection: modelSelection,
          userDisplayName: "Dilip",
        },
        { kind: "user" },
      );
      assert.equal(
        dispatched.filter((command) => command.type === "thread.messages.import").length,
        0,
      );
    }),
  );

  it.effect("forbids configuring an ordinary project", () =>
    Effect.gen(function* () {
      const service = yield* ProjectAgentService;
      const result = yield* Effect.exit(
        service.configure(
          {
            requestId: "req-ordinary-1",
            projectId: ordinaryId,
            coordinatorModelSelection: modelSelection,
          },
          { kind: "user" },
        ),
      );
      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("configures a legacy studio container", () =>
    Effect.gen(function* () {
      const service = yield* ProjectAgentService;
      const overview = yield* service.configure(
        {
          requestId: "req-studio-1",
          projectId: studioId,
          coordinatorModelSelection: modelSelection,
        },
        { kind: "user" },
      );
      assert.equal(overview.configured, true);
    }),
  );

  it.effect("lets a worker write memory but not instructions", () =>
    Effect.gen(function* () {
      const service = yield* ProjectAgentService;
      yield* service.configure(
        {
          requestId: "req-group-memory",
          projectId: groupId,
          coordinatorModelSelection: modelSelection,
        },
        { kind: "user" },
      );
      const worker = {
        kind: "worker" as const,
        threadId: ThreadId.makeUnsafe("thread-worker"),
        projectId: groupId,
        taskId: ProjectTaskId.makeUnsafe("task-1"),
      };
      const memory = yield* service.writeDocument(
        {
          requestId: "req-write-memory",
          projectId: groupId,
          logicalPath: "memory/MEMORY.md",
          content: "# Memory\n\nworker note\n",
        },
        worker,
      );
      assert.equal(memory.logicalPath, "memory/MEMORY.md");
      const instructions = yield* Effect.exit(
        service.writeDocument(
          {
            requestId: "req-write-instructions",
            projectId: groupId,
            logicalPath: "instructions.md",
            content: "nope",
          },
          worker,
        ),
      );
      assert.equal(instructions._tag, "Failure");
    }),
  );
});
