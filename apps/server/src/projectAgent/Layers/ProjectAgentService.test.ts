import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  ProjectId,
  ProjectTaskId,
  ThreadId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { memoryThreadDocumentPath } from "@synara/shared/projectAgent";
import { Effect, Exit, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { coordinatorWelcomeMessageId } from "../groupCoordinatorHost.ts";
import { ProjectAgentService } from "../Services/ProjectAgentService.ts";
import { ProjectAgentServiceLive } from "./ProjectAgentService.ts";

const groupId = ProjectId.makeUnsafe("project-group-1");
const groupId2 = ProjectId.makeUnsafe("project-group-2");
const ordinaryId = ProjectId.makeUnsafe("project-ordinary-1");
const studioId = ProjectId.makeUnsafe("project-studio-1");
const outsideGroupId = ProjectId.makeUnsafe("project-group-outside");
const modelSelection = { provider: "codex" as const, model: "gpt-5-codex" };
const limits = {
  maxConcurrentWorkers: 2,
  maxNewWorkersPerTurn: 4,
  maxWorkerCreationsPerGoal: 12,
  maxAutomaticContinuationsPerGoal: 20,
  maxRepairRoundsPerTask: 2,
};
const now = "2026-09-20T00:00:00.000Z";

function makeTestLayer(options?: {
  readonly failFirstImport?: boolean;
  readonly shellLookupError?: boolean;
}) {
  const dispatched: OrchestrationCommand[] = [];
  const automationUpdates: Array<{ readonly id: string; readonly enabled?: boolean }> = [];
  let failFirstImport = options?.failFirstImport === true;
  let shellBatchCalls = 0;
  const snapshotLayer = Layer.effect(
    ProjectionSnapshotQuery,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const getProjectShellById = (
        projectId: ProjectId,
      ): Effect.Effect<
        Option.Option<{
          id: ProjectId;
          kind: "group" | "studio" | "project";
          title: string;
          workspaceRoot: string;
          defaultModelSelection: null;
          scripts: never[];
          isPinned: boolean;
          spaceId: null;
          createdAt: string;
          updatedAt: string;
        }>
      > => {
        if (projectId === groupId || projectId === groupId2) {
          return Effect.succeed(
            Option.some({
              id: projectId,
              kind: "group" as const,
              title: "Alpha",
              workspaceRoot: `${config.groupsWorkspaceRoot}/alpha`,
              defaultModelSelection: null,
              scripts: [],
              isPinned: false,
              spaceId: null,
              createdAt: now,
              updatedAt: now,
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
              createdAt: now,
              updatedAt: now,
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
              createdAt: now,
              updatedAt: now,
            }),
          );
        }
        if (projectId === outsideGroupId) {
          return Effect.succeed(
            Option.some({
              id: outsideGroupId,
              kind: "group" as const,
              title: "Outside",
              workspaceRoot: "/tmp/not-groups/outside",
              defaultModelSelection: null,
              scripts: [],
              isPinned: false,
              spaceId: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
        }
        return Effect.succeed(Option.none());
      };
      return {
        getProjectShellById,
        getProjectShellsByIds: (projectIds: ReadonlyArray<ProjectId>) => {
          shellBatchCalls += 1;
          if (options?.shellLookupError) {
            return Effect.fail(new Error("sql down"));
          }
          return Effect.gen(function* () {
            const shells = [];
            for (const projectId of projectIds) {
              const option = yield* getProjectShellById(projectId);
              if (Option.isSome(option)) shells.push(option.value);
            }
            return shells;
          }) as ReturnType<ProjectionSnapshotQuery["Service"]["getProjectShellsByIds"]>;
        },
        getThreadDetailById: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQuery["Service"];
    }),
  );
  const orchestrationLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type === "thread.messages.import" && failFirstImport) {
          failFirstImport = false;
          return yield* Effect.fail(new Error("crash after thread"));
        }
      }),
  } as unknown as OrchestrationEngineService["Service"]);
  const automationLayer = Layer.succeed(AutomationService, {
    createProjectManaged: () =>
      Effect.succeed({
        id: AutomationId.makeUnsafe("automation-1"),
      }),
    list: () => Effect.succeed({ definitions: [], runs: [] }),
    update: (input: { readonly id: string; readonly enabled?: boolean }) => {
      automationUpdates.push({
        id: String(input.id),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
      return Effect.succeed({ id: input.id, prompt: "" });
    },
  } as unknown as AutomationService["Service"]);
  return {
    dispatched,
    automationUpdates,
    shellBatchCalls: () => shellBatchCalls,
    layer: ProjectAgentServiceLive.pipe(
      Layer.provide(snapshotLayer),
      Layer.provide(orchestrationLayer),
      Layer.provide(automationLayer),
      Layer.provide(Layer.succeed(TextGeneration, {} as unknown as TextGeneration["Service"])),
      Layer.provide(
        Layer.succeed(ProjectionThreadRepository, {
          listByProjectId: () => Effect.succeed([]),
        } as unknown as ProjectionThreadRepository["Service"]),
      ),
      Layer.provideMerge(ProjectAgentRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pa-group-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}

const leftoverConfig = {
  projectId: ordinaryId,
  coordinatorThreadId: ThreadId.makeUnsafe("thread-ordinary-coordinator"),
  coordinatorName: "Astra Bot",
  coordinatorModelSelection: modelSelection,
  limits,
  captureEnabled: true,
  enabled: true,
  automationId: AutomationId.makeUnsafe("automation-leftover"),
  revision: 1,
  createdAt: now,
  updatedAt: now,
  disabledAt: null,
};

it.effect("configures a group and imports exactly one greeting", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
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
    const imported = harness.dispatched.filter(
      (command) => command.type === "thread.messages.import",
    );
    assert.equal(imported.length, 1);
    if (imported[0]?.type === "thread.messages.import") {
      assert.equal(imported[0].messages[0]?.role, "assistant");
      assert.equal(
        imported[0].messages[0]?.text.includes("Hi Dilip, welcome to your new group."),
        true,
      );
      const threadCreate = harness.dispatched.find((command) => command.type === "thread.create");
      if (threadCreate?.type === "thread.create") {
        assert.equal(
          imported[0].messages[0]?.messageId,
          coordinatorWelcomeMessageId(threadCreate.threadId),
        );
      }
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("replays the same requestId without importing another greeting", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
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
    harness.dispatched.length = 0;
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
      harness.dispatched.filter((command) => command.type === "thread.messages.import").length,
      0,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not replay a receipt from another project", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const first = yield* service.configure(
      {
        requestId: "req-shared",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        coordinatorName: "First",
      },
      { kind: "user" },
    );
    const second = yield* service.configure(
      {
        requestId: "req-shared",
        projectId: groupId2,
        coordinatorModelSelection: modelSelection,
        coordinatorName: "Second",
      },
      { kind: "user" },
    );
    assert.equal(first.config?.coordinatorName, "First");
    assert.equal(second.config?.coordinatorName, "Second");
    assert.notEqual(first.config?.coordinatorThreadId, second.config?.coordinatorThreadId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("retries first setup after a crash with one thread and one greeting", () => {
  const harness = makeTestLayer({ failFirstImport: true });
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const failed = yield* Effect.exit(
      service.configure(
        {
          requestId: "req-crash",
          projectId: groupId,
          coordinatorModelSelection: modelSelection,
        },
        { kind: "user" },
      ),
    );
    assert.equal(failed._tag, "Failure");
    const overview = yield* service.configure(
      {
        requestId: "req-crash",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    assert.equal(overview.configured, true);
    assert.equal(
      harness.dispatched.filter((command) => command.type === "thread.create").length,
      1,
    );
    const imported = harness.dispatched.filter(
      (command) => command.type === "thread.messages.import",
    );
    assert.equal(imported.length, 2);
    if (
      imported[0]?.type === "thread.messages.import" &&
      imported[1]?.type === "thread.messages.import"
    ) {
      assert.equal(imported[0].messages[0]?.messageId, imported[1].messages[0]?.messageId);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("forbids configuring an ordinary project", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
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
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a group row outside the Groups root", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const result = yield* Effect.exit(
      service.configure(
        {
          requestId: "req-outside",
          projectId: outsideGroupId,
          coordinatorModelSelection: modelSelection,
        },
        { kind: "user" },
      ),
    );
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("configures a legacy studio container", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
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
  }).pipe(Effect.provide(harness.layer));
});

it.effect("forbids leftover ordinary-project coordinator reads and writes", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const principal = { kind: "user" as const };
    const overview = yield* Effect.exit(service.getOverview({ projectId: ordinaryId }, principal));
    const start = yield* Effect.exit(
      service.startGoal(
        { requestId: "req-goal", projectId: ordinaryId, objective: "Nope" },
        principal,
      ),
    );
    const docs = yield* Effect.exit(service.listDocuments({ projectId: ordinaryId }, principal));
    const write = yield* Effect.exit(
      service.writeDocument(
        {
          requestId: "req-write",
          projectId: ordinaryId,
          logicalPath: "notes.md",
          content: "x",
        },
        principal,
      ),
    );
    const subscribe = yield* Effect.exit(
      Stream.runDrain(service.streamEvents({ projectId: ordinaryId })),
    );
    assert.equal(overview._tag, "Failure");
    assert.equal(start._tag, "Failure");
    assert.equal(docs._tag, "Failure");
    assert.equal(write._tag, "Failure");
    assert.equal(subscribe._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("hides leftover ordinary configs and disables them on reconcile", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-group-visible",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* repository.saveConfig(leftoverConfig, null);
    const listed = yield* service.listSummaries({}, { kind: "user" });
    assert.equal(
      listed.summaries.some((row) => row.projectId === ordinaryId),
      false,
    );
    assert.equal(
      listed.summaries.some((row) => row.projectId === groupId),
      true,
    );
    yield* service.reconcilePendingWakes();
    const disabled = yield* repository.getConfig(ordinaryId);
    assert.equal(Option.isSome(disabled) && disabled.value.enabled === false, true);
    assert.equal(
      harness.automationUpdates.some((update) => update.enabled === false),
      true,
    );
    const activity = yield* repository.listActivity({ projectId: ordinaryId, limit: 10 });
    assert.equal(
      activity.some((row) => row.summary === "Coordinator disabled: this project is not a group."),
      true,
    );
    const activityAfterFirst = yield* repository.listActivity({
      projectId: ordinaryId,
      limit: 10,
    });
    yield* service.reconcilePendingWakes();
    const activityAfterSecond = yield* repository.listActivity({
      projectId: ordinaryId,
      limit: 10,
    });
    assert.equal(activityAfterSecond.length, activityAfterFirst.length);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("fails listSummaries when the shell lookup errors", () => {
  const harness = makeTestLayer({ shellLookupError: true });
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* repository.saveConfig(
      {
        ...leftoverConfig,
        projectId: groupId,
        coordinatorThreadId: ThreadId.makeUnsafe("thread-group-shell-error"),
        automationId: null,
      },
      null,
    );
    const result = yield* Effect.exit(service.listSummaries({}, { kind: "user" }));
    assert.equal(result._tag, "Failure");
    assert.equal(harness.shellBatchCalls(), 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("fetches shells for listSummaries in one query", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-group-a",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* service.configure(
      {
        requestId: "req-group-b",
        projectId: groupId2,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const before = harness.shellBatchCalls();
    yield* service.listSummaries({}, { kind: "user" });
    assert.equal(harness.shellBatchCalls(), before + 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("scopes memory writes to MEMORY.md and per-thread files", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* service.configure(
      {
        requestId: "req-group-memory",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const workerId = ThreadId.makeUnsafe("thread-worker");
    const worker = {
      kind: "worker" as const,
      threadId: workerId,
      projectId: groupId,
      taskId: ProjectTaskId.makeUnsafe("task-1"),
    };
    const own = yield* service.writeDocument(
      {
        requestId: "req-write-own",
        projectId: groupId,
        logicalPath: memoryThreadDocumentPath(workerId),
        content: "worker note",
      },
      worker,
    );
    assert.equal(own.logicalPath, memoryThreadDocumentPath(workerId));
    const other = yield* Effect.exit(
      service.writeDocument(
        {
          requestId: "req-write-other",
          projectId: groupId,
          logicalPath: memoryThreadDocumentPath(ThreadId.makeUnsafe("thread-other")),
          content: "nope",
        },
        worker,
      ),
    );
    assert.equal(other._tag, "Failure");
    const memory = yield* Effect.exit(
      service.writeDocument(
        {
          requestId: "req-write-memory",
          projectId: groupId,
          logicalPath: "memory/MEMORY.md",
          content: "nope",
        },
        worker,
      ),
    );
    assert.equal(memory._tag, "Failure");
    const coordinator = {
      kind: "coordinator" as const,
      threadId: overview.config!.coordinatorThreadId,
      projectId: groupId,
    };
    const curated = yield* service.writeDocument(
      {
        requestId: "req-coord-memory",
        projectId: groupId,
        logicalPath: "memory/MEMORY.md",
        content: "curated",
        expectedRevision: 1,
      },
      coordinator,
    );
    assert.equal(curated.logicalPath, "memory/MEMORY.md");
    const missingRevision = yield* Effect.exit(
      service.writeDocument(
        {
          requestId: "req-coord-memory-2",
          projectId: groupId,
          logicalPath: "memory/MEMORY.md",
          content: "again",
        },
        coordinator,
      ),
    );
    assert.equal(missingRevision._tag, "Failure");
    const userWrite = yield* service.writeDocument(
      {
        requestId: "req-user-memory",
        projectId: groupId,
        logicalPath: "memory/MEMORY.md",
        content: "user curated",
        expectedRevision: 2,
      },
      { kind: "user" },
    );
    assert.equal(userWrite.logicalPath, "memory/MEMORY.md");
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
  }).pipe(Effect.provide(harness.layer));
});
