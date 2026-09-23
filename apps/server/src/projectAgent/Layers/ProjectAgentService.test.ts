import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEventId,
  ProjectTaskId,
  ThreadId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { memoryThreadDocumentPath } from "@synara/shared/projectAgent";
import { Effect, Layer, Option, Stream } from "effect";

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
import { wakeReceiptRequestId } from "../digest.ts";
import { resolveLibraryRoot } from "../libraryStore.ts";
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

const groupMemberThreadId = ThreadId.makeUnsafe("thread-group-member");
const group2MemberThreadId = ThreadId.makeUnsafe("thread-group2-member");
const foreignThreadId = ThreadId.makeUnsafe("thread-foreign-project");

function makeTestLayer(options?: {
  readonly failFirstImport?: boolean;
  readonly shellLookupError?: boolean;
}) {
  const threadShells: Record<
    string,
    {
      projectId: ProjectId;
      title: string;
      session: { status: string; updatedAt: string; lastError: string | null } | null;
      latestTurn?: { state: string } | null;
      hasPendingApprovals?: boolean;
    }
  > = {
    [groupMemberThreadId]: {
      projectId: groupId,
      title: "Group member chat",
      session: { status: "ready", updatedAt: now, lastError: null },
    },
    [group2MemberThreadId]: {
      projectId: groupId2,
      title: "Other group chat",
      session: { status: "ready", updatedAt: now, lastError: null },
    },
    [foreignThreadId]: {
      projectId: ordinaryId,
      title: "Foreign thread",
      session: null,
    },
  };
  const getThreadShellById = (threadId: ThreadId) => {
    const row = threadShells[threadId];
    if (!row) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: threadId,
        projectId: row.projectId,
        title: row.title,
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "collaboration",
        branch: null,
        worktreePath: null,
        workingDirectory: null,
        envMode: "local",
        messages: [],
        latestTurn: row.latestTurn ?? null,
        hasPendingApprovals: row.hasPendingApprovals === true,
        archivedAt: null,
        deletedAt: null,
        settledAt: null,
        handoff: null,
        session: row.session,
        createdAt: now,
        updatedAt: now,
      }),
    );
  };
  const dispatched: OrchestrationCommand[] = [];
  const automationUpdates: Array<{ readonly id: string; readonly enabled?: boolean }> = [];
  const runNowCalls: string[] = [];
  const automationRuns: Array<{ readonly id: string }> = [];
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
        getThreadShellById,
        getThreadShellsByIds: (threadIds: ReadonlyArray<ThreadId>) =>
          Effect.forEach(threadIds, getThreadShellById).pipe(
            Effect.map((options) => options.filter(Option.isSome).map((o) => o.value)),
          ),
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
    runNow: (input: { readonly automationId: string }) => {
      runNowCalls.push(String(input.automationId));
      return Effect.succeed({ run: { id: `run-test-${runNowCalls.length}` } });
    },
    listRunsForDefinition: () => Effect.succeed([...automationRuns]),
  } as unknown as AutomationService["Service"]);
  return {
    dispatched,
    automationUpdates,
    runNowCalls,
    automationRuns,
    threadShells,
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

it.effect("links an ordinary repository to a group and is idempotent", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-link-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const first = yield* service.linkProject(
      {
        requestId: "req-link-1",
        projectId: groupId,
        linkedProjectId: ordinaryId,
      },
      { kind: "user" },
    );
    assert.deepEqual(first.config?.linkedProjectIds, [ordinaryId]);
    const second = yield* service.linkProject(
      {
        requestId: "req-link-2",
        projectId: groupId,
        linkedProjectId: ordinaryId,
      },
      { kind: "user" },
    );
    assert.deepEqual(second.config?.linkedProjectIds, [ordinaryId]);
    const overview = yield* service.getOverview({ projectId: groupId }, { kind: "user" });
    assert.deepEqual(overview.config?.linkedProjectIds, [ordinaryId]);
    const unlinked = yield* service.unlinkProject(
      {
        requestId: "req-unlink-1",
        projectId: groupId,
        linkedProjectId: ordinaryId,
      },
      { kind: "user" },
    );
    assert.deepEqual(unlinked.config?.linkedProjectIds, []);
    const noop = yield* service.unlinkProject(
      {
        requestId: "req-unlink-2",
        projectId: groupId,
        linkedProjectId: ordinaryId,
      },
      { kind: "user" },
    );
    assert.deepEqual(noop.config?.linkedProjectIds, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects linking a container, the group itself, or an unknown project", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-link-reject-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const self = yield* Effect.exit(
      service.linkProject(
        { requestId: "req-link-self", projectId: groupId, linkedProjectId: groupId },
        { kind: "user" },
      ),
    );
    const studio = yield* Effect.exit(
      service.linkProject(
        { requestId: "req-link-studio", projectId: groupId, linkedProjectId: studioId },
        { kind: "user" },
      ),
    );
    const unknown = yield* Effect.exit(
      service.linkProject(
        {
          requestId: "req-link-unknown",
          projectId: groupId,
          linkedProjectId: ProjectId.makeUnsafe("project-missing"),
        },
        { kind: "user" },
      ),
    );
    assert.equal(self._tag, "Failure");
    assert.equal(studio._tag, "Failure");
    assert.equal(unknown._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("allows group-coordinator thread creation in the group or a linked repo", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* service.configure(
      {
        requestId: "req-allowlist-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const coordinatorThreadId = overview.config!.coordinatorThreadId;
    yield* service.assertCallerMayCreateThreadInProject({
      callerThreadId: coordinatorThreadId,
      targetProjectId: groupId,
    });
    yield* service.linkProject(
      { requestId: "req-allowlist-link", projectId: groupId, linkedProjectId: ordinaryId },
      { kind: "user" },
    );
    yield* service.assertCallerMayCreateThreadInProject({
      callerThreadId: coordinatorThreadId,
      targetProjectId: ordinaryId,
    });
    const rejected = yield* Effect.exit(
      service.assertCallerMayCreateThreadInProject({
        callerThreadId: coordinatorThreadId,
        targetProjectId: groupId2,
      }),
    );
    assert.equal(rejected._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("round-trips library hosting fields and rejects a relative libraryPath", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const relative = yield* Effect.exit(
      service.configure(
        {
          requestId: "req-lib-relative",
          projectId: groupId,
          coordinatorModelSelection: modelSelection,
          libraryPath: "relative/library",
        },
        { kind: "user" },
      ),
    );
    assert.equal(relative._tag, "Failure");
    const config = yield* ServerConfig;
    const customLibraryPath = `${config.stateDir}/group-library`;
    const overview = yield* service.configure(
      {
        requestId: "req-lib-ok",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        libraryPath: customLibraryPath,
        libraryRemoteUrl: "https://example.com/library.git",
        libraryPushOnChange: true,
      },
      { kind: "user" },
    );
    assert.equal(overview.config?.libraryPath, customLibraryPath);
    assert.equal(overview.config?.libraryRemoteUrl, "https://example.com/library.git");
    assert.equal(overview.config?.libraryPushOnChange, true);
    const preserved = yield* service.configure(
      {
        requestId: "req-lib-preserve",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        expectedRevision: overview.config?.revision,
      },
      { kind: "user" },
    );
    assert.equal(preserved.config?.libraryPath, customLibraryPath);
    assert.equal(preserved.config?.libraryRemoteUrl, "https://example.com/library.git");
    assert.equal(preserved.config?.libraryPushOnChange, true);
    // `null` clears the column; absent (as above) preserves it.
    const cleared = yield* service.configure(
      {
        requestId: "req-lib-clear",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        expectedRevision: preserved.config?.revision,
        libraryPath: null,
        libraryRemoteUrl: null,
      },
      { kind: "user" },
    );
    assert.equal(cleared.config?.libraryPath, undefined);
    assert.equal(cleared.config?.libraryRemoteUrl, undefined);
    assert.equal(cleared.config?.libraryPushOnChange, true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("forbids a context packet across groups but allows own-group members (S1)", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-ctx-a",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* service.configure(
      {
        requestId: "req-ctx-b",
        projectId: groupId2,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const own = yield* service.buildContextPacket(groupId, groupMemberThreadId);
    assert.equal(own.projectId, groupId);
    const cross = yield* Effect.exit(service.buildContextPacket(groupId, group2MemberThreadId));
    assert.equal(cross._tag, "Failure");
    const foreign = yield* Effect.exit(service.buildContextPacket(groupId, foreignThreadId));
    assert.equal(foreign._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("indexes routine group turns as non-wake and alert settles as wakeable", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-wake-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* service.ingestSettledThreadEvent({
      threadId: groupMemberThreadId,
      sourceEventId: "routine-turn-1",
      eventType: "thread.turn-diff-completed",
      createdAt: now,
    });
    const rows = yield* repository.listInboxAfter({ projectId: groupId, limit: 10 });
    const routine = rows.find((row) => row.sourceEventId === "routine-turn-1");
    assert.equal(routine?.eligibleWake, false);

    const before = yield* repository.getCursor(groupId);
    yield* service.ingestSettledThreadEvent({
      threadId: groupMemberThreadId,
      sourceEventId: "needs-user-1",
      eventType: "thread.user-input-response-requested",
      createdAt: "2026-09-20T00:01:00.000Z",
    });
    const after = yield* repository.listInboxAfter({ projectId: groupId, limit: 10 });
    const alert = after.find((row) => row.sourceEventId === "needs-user-1");
    assert.equal(alert?.eligibleWake, true);
    // The alert dispatched a coordinator continuation through the automation.
    const cursor = yield* repository.getCursor(groupId);
    assert.equal(cursor.frozenFromInboxId === null || cursor.coordinatorBusy === false, true);
    assert.equal(before.coordinatorBusy, false);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("resolves linked-repo workers through the task assignment", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-linked-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const linkedWorkerThreadId = ThreadId.makeUnsafe("thread-linked-worker");
    const goalId = ProjectGoalId.makeUnsafe("goal-linked");
    yield* repository.saveGoal(
      {
        id: goalId,
        projectId: groupId,
        objective: "Coordinate linked repos",
        authorizationSource: "user",
        scopeVersion: 1,
        acceptanceCriteria: null,
        limits,
        status: "active",
        continuationCount: 0,
        workerCreationCount: 0,
        authorizedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    yield* repository.saveTask(
      {
        id: ProjectTaskId.makeUnsafe("task-linked"),
        projectId: groupId,
        goalId,
        title: "Patch linked repo",
        description: null,
        acceptanceCriteria: null,
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: linkedWorkerThreadId,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    // No thread shell: the worker lives in the linked repo's project, not the
    // group — it must still resolve as this group's worker.
    const principal = yield* service.resolvePrincipalForThread(linkedWorkerThreadId);
    assert.equal(principal.kind, "worker");
    if (principal.kind === "worker") {
      assert.equal(principal.projectId, groupId);
      assert.equal(principal.taskId, ProjectTaskId.makeUnsafe("task-linked"));
    }
    yield* service.ingestSettledThreadEvent({
      threadId: linkedWorkerThreadId,
      sourceEventId: "linked-turn-1",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:02:00.000Z",
    });
    const rows = yield* repository.listInboxAfter({ projectId: groupId, limit: 10 });
    const wake = rows.find((row) => row.sourceEventId === "linked-turn-1");
    assert.equal(wake?.eligibleWake, true);
    const report = yield* repository.getDocumentHead(
      groupId,
      `inbox/${linkedWorkerThreadId}/report.md`,
    );
    assert.equal(Option.isSome(report), true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("blocks curated writes for group members and unmanaged threads", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-s5-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const member = {
      kind: "group-member" as const,
      threadId: groupMemberThreadId,
      projectId: groupId,
    };
    const curated = yield* Effect.exit(
      service.writeDocument(
        {
          requestId: "req-member-curated",
          projectId: groupId,
          logicalPath: "decisions.md",
          content: "nope",
        },
        member,
      ),
    );
    assert.equal(curated._tag, "Failure");
    const otherInbox = yield* Effect.exit(
      service.writeDocument(
        {
          requestId: "req-member-inbox",
          projectId: groupId,
          logicalPath: "inbox/thread-other/report.md",
          content: "nope",
        },
        member,
      ),
    );
    assert.equal(otherInbox._tag, "Failure");
    const ownMemory = yield* service.writeDocument(
      {
        requestId: "req-member-memory",
        projectId: groupId,
        logicalPath: memoryThreadDocumentPath(groupMemberThreadId),
        content: "remembered",
      },
      member,
    );
    assert.equal(ownMemory.logicalPath, memoryThreadDocumentPath(groupMemberThreadId));
    const unmanaged = {
      kind: "unmanaged" as const,
      threadId: foreignThreadId,
      projectId: groupId,
    };
    const unmanagedCurated = yield* Effect.exit(
      service.writeDocument(
        {
          requestId: "req-unmanaged-curated",
          projectId: groupId,
          logicalPath: "decisions.md",
          content: "nope",
        },
        unmanaged,
      ),
    );
    assert.equal(unmanagedCurated._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("resumes a frozen busy wake cursor instead of stalling forever", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-busy-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-busy-1"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "busy-1",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T00:03:00.000Z",
    });
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-busy-2"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "busy-2",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T00:03:30.000Z",
    });
    // Simulate the crash: the range was frozen and the busy flag left set.
    yield* repository.saveCursor({
      projectId: groupId,
      processedThroughInboxId: null,
      processedThroughCreatedAt: null,
      frozenFromInboxId: "inbox-busy-1",
      frozenToInboxId: "inbox-busy-2",
      coordinatorBusy: true,
      coordinatorBusySince: "2026-09-20T00:03:01.000Z",
      updatedAt: "2026-09-20T00:03:01.000Z",
    });
    yield* service.reconcilePendingWakes();
    const cursor = yield* repository.getCursor(groupId);
    assert.equal(cursor.coordinatorBusy, false);
    assert.equal(cursor.frozenFromInboxId, null);
    assert.equal(cursor.processedThroughInboxId, "inbox-busy-2");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("clears a bare busy cursor left by a crash before freezing", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-barebusy-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* repository.saveCursor({
      projectId: groupId,
      processedThroughInboxId: null,
      processedThroughCreatedAt: null,
      frozenFromInboxId: null,
      frozenToInboxId: null,
      coordinatorBusy: true,
      coordinatorBusySince: "2026-09-20T00:04:00.000Z",
      updatedAt: "2026-09-20T00:04:00.000Z",
    });
    yield* service.reconcilePendingWakes();
    const cursor = yield* repository.getCursor(groupId);
    assert.equal(cursor.coordinatorBusy, false);
    assert.equal(cursor.coordinatorBusySince, null);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("pages past a full page of non-wake rows to reach a worker alert", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-paging-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    // 60 consumed-only rows fill more than one 50-row read window.
    for (let i = 0; i < 60; i += 1) {
      yield* repository.insertInboxEvent({
        id: ProjectInboxEventId.makeUnsafe(`inbox-nonwake-${i}`),
        projectId: groupId,
        sourceThreadId: groupMemberThreadId,
        sourceEventId: `nonwake-${i}`,
        eventType: "thread.settled",
        taskId: null,
        eligibleWake: false,
        createdAt: `2026-09-20T00:05:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-alert-1"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "alert-1",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T00:06:00.000Z",
    });
    yield* service.processPendingWakes(groupId);
    // The scan consumed every non-wake row across both pages and dispatched
    // exactly one continuation for the alert it finally reached.
    assert.equal(harness.runNowCalls.length, 1);
    const cursor = yield* repository.getCursor(groupId);
    assert.equal(cursor.processedThroughInboxId, "inbox-alert-1");
    assert.equal(cursor.processedThroughCreatedAt, "2026-09-20T00:06:00.000Z");
    assert.equal(cursor.coordinatorBusy, false);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("restores the frozen boundary row by id past the 500-row window", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-boundary-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    // The boundary row sits outside any single page window: 550 rows were
    // indexed before it, so a window scan can never find it by position.
    for (let i = 0; i < 550; i += 1) {
      yield* repository.insertInboxEvent({
        id: ProjectInboxEventId.makeUnsafe(`inbox-filler-${i}`),
        projectId: groupId,
        sourceThreadId: groupMemberThreadId,
        sourceEventId: `filler-${i}`,
        eventType: "thread.settled",
        taskId: null,
        eligibleWake: false,
        createdAt: `2026-09-20T00:01:${String(i).padStart(3, "0")}.000Z`,
      });
    }
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-boundary"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "boundary",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T02:00:00.000Z",
    });
    yield* repository.saveCursor({
      projectId: groupId,
      processedThroughInboxId: "inbox-filler-0",
      processedThroughCreatedAt: "2026-09-20T00:01:000.000Z",
      frozenFromInboxId: "inbox-boundary",
      frozenToInboxId: "inbox-boundary",
      coordinatorBusy: true,
      coordinatorBusySince: "2026-09-20T00:03:01.000Z",
      updatedAt: "2026-09-20T00:03:01.000Z",
    });
    yield* service.reconcilePendingWakes();
    const cursor = yield* repository.getCursor(groupId);
    // Both cursor fields come from the boundary row itself — never a stale
    // timestamp paired with the new id.
    assert.equal(cursor.processedThroughInboxId, "inbox-boundary");
    assert.equal(cursor.processedThroughCreatedAt, "2026-09-20T02:00:00.000Z");
    assert.equal(cursor.coordinatorBusy, false);
    assert.equal(harness.runNowCalls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("leaves a young busy cursor alone while the coordinator is mid-turn", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-livebusy-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const config = yield* repository.getConfig(groupId);
    assert.equal(Option.isSome(config), true);
    if (Option.isNone(config)) return;
    // The coordinator thread is genuinely mid-turn — the busy marker is live
    // work, not a crash remnant, so recovery must not stack a second
    // continuation on top of it.
    harness.threadShells[config.value.coordinatorThreadId] = {
      projectId: groupId,
      title: "Alpha Coordinator",
      session: { status: "running", updatedAt: now, lastError: null },
      latestTurn: { state: "running" },
    };
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-livebusy"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "livebusy",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T00:03:00.000Z",
    });
    yield* repository.saveCursor({
      projectId: groupId,
      processedThroughInboxId: null,
      processedThroughCreatedAt: null,
      frozenFromInboxId: "inbox-livebusy",
      frozenToInboxId: "inbox-livebusy",
      coordinatorBusy: true,
      coordinatorBusySince: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    yield* service.reconcilePendingWakes();
    assert.equal(harness.runNowCalls.length, 0);
    const cursor = yield* repository.getCursor(groupId);
    assert.equal(cursor.coordinatorBusy, true);
    assert.equal(cursor.frozenToInboxId, "inbox-livebusy");

    // An idle coordinator behind a young marker is still dispatched — the
    // marker alone does not suppress recovery.
    harness.threadShells[config.value.coordinatorThreadId] = {
      projectId: groupId,
      title: "Alpha Coordinator",
      session: { status: "ready", updatedAt: now, lastError: null },
      latestTurn: { state: "completed" },
    };
    yield* service.reconcilePendingWakes();
    assert.equal(harness.runNowCalls.length, 1);
    const after = yield* repository.getCursor(groupId);
    assert.equal(after.coordinatorBusy, false);
    assert.equal(after.processedThroughInboxId, "inbox-livebusy");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("adopts the run behind a young claim instead of double-dispatching", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-claim-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-claim-1"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "claim-1",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T00:03:00.000Z",
    });
    const receiptId = wakeReceiptRequestId({
      projectId: groupId,
      fromInboxId: "inbox-claim-1",
      toInboxId: "inbox-claim-1",
    });
    // The previous attempt claimed the range and started a run, then died
    // before storing the wake receipt. The claim resolves the run it launched
    // — a second runNow would double-dispatch the same continuation.
    yield* repository.saveReceipt({
      requestId: `${receiptId}:claim`,
      projectId: groupId,
      operation: "wake-claim",
      resultJson: JSON.stringify({ claimedAt: new Date().toISOString() }),
      createdAt: new Date().toISOString(),
    });
    harness.automationRuns.push({ id: "run-rescued-1" });
    yield* repository.saveCursor({
      projectId: groupId,
      processedThroughInboxId: null,
      processedThroughCreatedAt: null,
      frozenFromInboxId: "inbox-claim-1",
      frozenToInboxId: "inbox-claim-1",
      coordinatorBusy: true,
      coordinatorBusySince: "2026-09-20T00:03:01.000Z",
      updatedAt: "2026-09-20T00:03:01.000Z",
    });
    yield* service.reconcilePendingWakes();
    assert.equal(harness.runNowCalls.length, 0);
    const receipt = yield* repository.getReceipt({ requestId: receiptId, projectId: groupId });
    assert.equal(Option.isSome(receipt), true);
    if (Option.isSome(receipt)) {
      assert.equal(JSON.parse(receipt.value.resultJson).runId, "run-rescued-1");
    }
    const cursor = yield* repository.getCursor(groupId);
    assert.equal(cursor.coordinatorBusy, false);
    assert.equal(cursor.processedThroughInboxId, "inbox-claim-1");

    // A young claim whose run is not yet visible leaves the range for the
    // next wake instead of racing a duplicate dispatch.
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-claim-2"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "claim-2",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T00:04:00.000Z",
    });
    const pendingReceiptId = wakeReceiptRequestId({
      projectId: groupId,
      fromInboxId: "inbox-claim-2",
      toInboxId: "inbox-claim-2",
    });
    yield* repository.saveReceipt({
      requestId: `${pendingReceiptId}:claim`,
      projectId: groupId,
      operation: "wake-claim",
      resultJson: JSON.stringify({ claimedAt: new Date().toISOString() }),
      createdAt: new Date().toISOString(),
    });
    harness.automationRuns.length = 0;
    yield* repository.saveCursor({
      projectId: groupId,
      processedThroughInboxId: "inbox-claim-1",
      processedThroughCreatedAt: "2026-09-20T00:03:00.000Z",
      frozenFromInboxId: "inbox-claim-2",
      frozenToInboxId: "inbox-claim-2",
      coordinatorBusy: true,
      coordinatorBusySince: "2026-09-20T00:04:01.000Z",
      updatedAt: "2026-09-20T00:04:01.000Z",
    });
    yield* service.reconcilePendingWakes();
    assert.equal(harness.runNowCalls.length, 0);
    const stillFrozen = yield* repository.getCursor(groupId);
    assert.equal(stillFrozen.coordinatorBusy, true);
    assert.equal(stillFrozen.frozenToInboxId, "inbox-claim-2");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("configure onto the same canonical library root returns promptly", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const serverConfig = yield* ServerConfig;
    yield* service.configure(
      {
        requestId: "req-lock-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const defaultRoot = yield* resolveLibraryRoot({
      stateDir: serverConfig.stateDir,
      projectId: groupId,
    });
    // Re-pointing the library at the same physical folder — literally, with a
    // trailing slash, or through a symlink — used to nest the same
    // non-re-entrant queue inside itself and hang configure forever. Each
    // variant completing inside the suite timeout is the regression
    // assertion.
    const aliasLink = path.join(serverConfig.stateDir, "library-alias");
    yield* Effect.promise(() => fs.symlink(defaultRoot, aliasLink, "dir"));
    let revision = 0;
    for (const libraryPath of [defaultRoot, `${defaultRoot}/`, aliasLink]) {
      revision += 1;
      yield* service.configure(
        {
          requestId: `req-lock-${revision}`,
          projectId: groupId,
          coordinatorModelSelection: modelSelection,
          libraryPath,
        },
        { kind: "user" },
      );
    }
    const config = yield* repository.getConfig(groupId);
    assert.equal(Option.isSome(config), true);
    if (Option.isSome(config)) {
      assert.equal(config.value.libraryPath, aliasLink);
    }
    // A real relocation still moves the tree.
    const elsewhere = path.join(serverConfig.stateDir, "library-moved");
    yield* service.configure(
      {
        requestId: "req-lock-moved",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        libraryPath: elsewhere,
      },
      { kind: "user" },
    );
    const moved = yield* repository.getConfig(groupId);
    assert.equal(Option.isSome(moved), true);
    if (Option.isSome(moved)) {
      assert.equal(moved.value.libraryPath, elsewhere);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps stored limits and captureEnabled when configure omits them", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* service.configure(
      {
        requestId: "req-limits-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        limits,
        captureEnabled: false,
      },
      { kind: "user" },
    );
    assert.equal(overview.config?.limits.maxConcurrentWorkers, 2);
    assert.equal(overview.config?.captureEnabled, false);
    const updated = yield* service.configure(
      {
        requestId: "req-limits-update",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        goal: "new goal",
        expectedRevision: overview.config?.revision,
      },
      { kind: "user" },
    );
    assert.equal(updated.config?.limits.maxConcurrentWorkers, 2);
    assert.equal(updated.config?.limits.maxWorkerCreationsPerGoal, 12);
    assert.equal(updated.config?.captureEnabled, false);
    assert.equal(updated.config?.goal, "new goal");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects cross-project task and evidence access", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* service.configure(
      {
        requestId: "req-xproj-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    yield* service.configure(
      {
        requestId: "req-xproj-other",
        projectId: groupId2,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const goalId = ProjectGoalId.makeUnsafe("goal-xproj");
    yield* repository.saveGoal(
      {
        id: goalId,
        projectId: groupId2,
        objective: "Other project goal",
        authorizationSource: "user",
        scopeVersion: 1,
        acceptanceCriteria: null,
        limits,
        status: "active",
        continuationCount: 0,
        workerCreationCount: 0,
        authorizedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    const foreignTaskId = ProjectTaskId.makeUnsafe("task-foreign");
    yield* repository.saveTask(
      {
        id: foreignTaskId,
        projectId: groupId2,
        goalId,
        title: "Foreign task",
        description: null,
        acceptanceCriteria: null,
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: null,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    const evidence = yield* Effect.exit(
      service.listEvidence({ projectId: groupId, taskId: foreignTaskId }, { kind: "user" }),
    );
    assert.equal(evidence._tag, "Failure");
    const reported = yield* Effect.exit(
      service.reportResult(
        {
          requestId: "req-xproj-report",
          projectId: groupId,
          taskId: foreignTaskId,
          summary: "done",
        },
        {
          kind: "coordinator" as const,
          threadId: overview.config!.coordinatorThreadId,
          projectId: groupId,
        },
      ),
    );
    assert.equal(reported._tag, "Failure");
    const updated = yield* Effect.exit(
      service.updateTask(
        {
          requestId: "req-xproj-update",
          projectId: groupId,
          taskId: foreignTaskId,
          expectedRevision: 1,
          title: "hijacked",
        },
        { kind: "user" },
      ),
    );
    assert.equal(updated._tag, "Failure");
    // A worker may not touch tasks that are not its own.
    const otherWorker = yield* Effect.exit(
      service.updateTask(
        {
          requestId: "req-worker-other",
          projectId: groupId,
          taskId: foreignTaskId,
          expectedRevision: 1,
          status: "running",
        },
        {
          kind: "worker" as const,
          threadId: ThreadId.makeUnsafe("thread-some-worker"),
          projectId: groupId,
          taskId: ProjectTaskId.makeUnsafe("task-not-this-one"),
        },
      ),
    );
    assert.equal(otherWorker._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("routes a done update through the accept path and validates dependency projects", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-done-setup",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const goalId = ProjectGoalId.makeUnsafe("goal-done");
    yield* repository.saveGoal(
      {
        id: goalId,
        projectId: groupId,
        objective: "Done flow",
        authorizationSource: "user",
        scopeVersion: 1,
        acceptanceCriteria: "evidence required",
        limits,
        status: "active",
        continuationCount: 0,
        workerCreationCount: 0,
        authorizedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    const taskId = ProjectTaskId.makeUnsafe("task-done");
    yield* repository.saveTask(
      {
        id: taskId,
        projectId: groupId,
        goalId,
        title: "Finish me",
        description: null,
        acceptanceCriteria: "needs evidence",
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: null,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    // done without evidence must fail — it goes through the accept path.
    const noEvidence = yield* Effect.exit(
      service.updateTask(
        {
          requestId: "req-done-noev",
          projectId: groupId,
          taskId,
          expectedRevision: 1,
          status: "done",
        },
        { kind: "user" },
      ),
    );
    assert.equal(noEvidence._tag, "Failure");
    const task = yield* repository.getTask(taskId);
    assert.equal(Option.isSome(task) && task.value.status === "running", true);
    // Cross-project dependsOnTaskIds are rejected.
    yield* service.configure(
      {
        requestId: "req-done-xdep",
        projectId: groupId2,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const foreignTask = ProjectTaskId.makeUnsafe("task-other-project");
    yield* repository.saveGoal(
      {
        id: ProjectGoalId.makeUnsafe("goal-xdep"),
        projectId: groupId2,
        objective: "x",
        authorizationSource: "user",
        scopeVersion: 1,
        acceptanceCriteria: null,
        limits,
        status: "active",
        continuationCount: 0,
        workerCreationCount: 0,
        authorizedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    yield* repository.saveTask(
      {
        id: foreignTask,
        projectId: groupId2,
        goalId: ProjectGoalId.makeUnsafe("goal-xdep"),
        title: "foreign dep",
        description: null,
        acceptanceCriteria: null,
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: null,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    const badDep = yield* Effect.exit(
      service.updateTask(
        {
          requestId: "req-done-baddep",
          projectId: groupId,
          taskId,
          expectedRevision: 1,
          dependsOnTaskIds: [foreignTask],
        },
        { kind: "user" },
      ),
    );
    assert.equal(badDep._tag, "Failure");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("configure reuses the existing coordinator thread on retry", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const first = yield* service.configure(
      {
        requestId: "req-idem-1",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const second = yield* service.configure(
      {
        requestId: "req-idem-2",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        expectedRevision: first.config?.revision,
      },
      { kind: "user" },
    );
    assert.equal(second.config?.coordinatorThreadId, first.config?.coordinatorThreadId);
    assert.equal(
      harness.dispatched.filter((command) => command.type === "thread.create").length,
      1,
    );
  }).pipe(Effect.provide(harness.layer));
});
