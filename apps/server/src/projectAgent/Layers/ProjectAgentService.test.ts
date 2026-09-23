import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  ProjectDocumentRevisionId,
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
import { GitCore } from "../../git/Services/GitCore.ts";
import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { coordinatorWelcomeMessageId } from "../groupCoordinatorHost.ts";
import {
  PROJECT_BOT_HEARTBEAT_PROMPT,
  PROJECT_BOT_PLAYBOOK,
  PROJECT_BOT_PLAYBOOK_PATH,
} from "../projectBotPlaybook.ts";
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

const lineTargetsPath = (line: string, logicalPath: string) =>
  (line.split(" — ", 1)[0] ?? line).endsWith(`](${logicalPath})`);
const foreignThreadId = ThreadId.makeUnsafe("thread-foreign-project");

function makeTestLayer(options?: {
  readonly failFirstImport?: boolean;
  readonly shellLookupError?: boolean;
  readonly failCommandTypes?: ReadonlyArray<OrchestrationCommand["type"]>;
}) {
  const threadShells: Record<
    string,
    {
      projectId: ProjectId;
      title: string;
      session: { status: string; updatedAt: string; lastError: string | null } | null;
      latestTurn?: {
        state: string;
        startedAt?: string;
        completedAt?: string | null;
      } | null;
      hasPendingApprovals?: boolean;
      hasPendingUserInput?: boolean;
      archivedAt?: string | null;
      lastKnownPr?: { url: string; state: string; isDraft: boolean } | null;
      updatedAt?: string;
      worktreePath?: string | null;
      workingDirectory?: string | null;
      envMode?: string;
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
        worktreePath: row.worktreePath ?? null,
        workingDirectory: row.workingDirectory ?? null,
        envMode: row.envMode ?? "local",
        messages: [],
        latestTurn: row.latestTurn ?? null,
        hasPendingApprovals: row.hasPendingApprovals === true,
        hasPendingUserInput: row.hasPendingUserInput === true,
        archivedAt: row.archivedAt ?? null,
        deletedAt: null,
        settledAt: null,
        handoff: null,
        session: row.session,
        lastKnownPr: row.lastKnownPr ?? null,
        createdAt: now,
        updatedAt: row.updatedAt ?? now,
      }),
    );
  };
  const dispatched: OrchestrationCommand[] = [];
  const automationDefinitions: Array<{
    readonly id: string;
    readonly enabled: boolean;
    readonly archivedAt: string | null;
    readonly prompt: string;
  }> = [];
  const automationUpdates: Array<{ readonly id: string; readonly enabled?: boolean }> = [];
  const automationDeletes: string[] = [];
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
        getActiveProjectByWorkspaceRoot: (workspaceRoot: string) =>
          Effect.succeed(
            workspaceRoot === path.resolve("/tmp/app")
              ? Option.some({ id: ordinaryId, title: "App" })
              : Option.none(),
          ) as ReturnType<ProjectionSnapshotQuery["Service"]["getActiveProjectByWorkspaceRoot"]>,
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
        if (options?.failCommandTypes?.includes(command.type)) {
          return yield* Effect.fail(new Error(`refusing ${command.type}`));
        }
      }),
  } as unknown as OrchestrationEngineService["Service"]);
  const automationLayer = Layer.succeed(AutomationService, {
    createProjectManaged: () =>
      Effect.succeed({
        id: AutomationId.makeUnsafe("automation-1"),
      }),
    list: () => Effect.succeed({ definitions: [...automationDefinitions], runs: [] }),
    delete: (input: { readonly id: string }) => {
      automationDeletes.push(String(input.id));
      return Effect.succeed({ deleted: true });
    },
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
    automationDefinitions,
    automationUpdates,
    automationDeletes,
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
        Layer.succeed(GitCore, {
          withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
          execute: () =>
            Effect.succeed({
              code: 0,
              stdout: "0123456789abcdef0123456789abcdef01234567\n",
              stderr: "",
            }),
        } as unknown as (typeof GitCore)["Service"]),
      ),
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

it.effect("surfaces linked projects in the overview before the group is configured", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const linked = yield* service.linkProject(
      {
        requestId: "req-link-preconfig",
        projectId: groupId,
        linkedProjectId: ordinaryId,
      },
      { kind: "user" },
    );
    assert.equal(linked.config, null);
    assert.equal(linked.configured, false);
    assert.deepEqual(linked.linkedProjectIds, [ordinaryId]);
    const overview = yield* service.getOverview({ projectId: groupId }, { kind: "user" });
    assert.equal(overview.config, null);
    assert.deepEqual(overview.linkedProjectIds, [ordinaryId]);
    const configured = yield* service.configure(
      {
        requestId: "req-link-preconfig-configure",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    assert.deepEqual(configured.linkedProjectIds, [ordinaryId]);
    assert.deepEqual(configured.config?.linkedProjectIds, [ordinaryId]);
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

// ---- Group tools + lifecycle (PR 13) ----

const configureTestGroup = (
  service: ProjectAgentService["Service"],
  requestId: string,
  overrides: {
    readonly projectId?: ProjectId;
    readonly libraryPath?: string;
    readonly goal?: string;
  } = {},
) =>
  service.configure(
    {
      requestId,
      projectId: overrides.projectId ?? groupId,
      coordinatorModelSelection: modelSelection,
      ...(overrides.libraryPath === undefined ? {} : { libraryPath: overrides.libraryPath }),
      ...(overrides.goal === undefined ? {} : { goal: overrides.goal }),
    },
    { kind: "user" },
  );

const coordinatorPrincipal = (coordinatorThreadId: ThreadId) =>
  ({
    kind: "coordinator",
    threadId: coordinatorThreadId,
    projectId: groupId,
  }) as const;

const memberPrincipal = (
  threadId: ThreadId = groupMemberThreadId,
  projectId: ProjectId = groupId,
) => ({ kind: "group-member", threadId, projectId }) as const;

const workerPrincipal = (
  threadId: ThreadId = ThreadId.makeUnsafe("thread-worker"),
  projectId: ProjectId = groupId,
) =>
  ({
    kind: "worker",
    threadId,
    projectId,
    taskId: ProjectTaskId.makeUnsafe("task-1"),
  }) as const;

it.effect("gates the new group tools by principal kind", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* configureTestGroup(service, "req-gate-setup");
    const coordinatorThreadId = overview.config?.coordinatorThreadId;
    assert.equal(coordinatorThreadId !== null && coordinatorThreadId !== undefined, true);
    const coordinator = coordinatorPrincipal(coordinatorThreadId!);
    const member = memberPrincipal();
    const worker = workerPrincipal();
    const foreignWorker = workerPrincipal(foreignThreadId, ordinaryId);
    const unmanaged = {
      kind: "unmanaged",
      threadId: foreignThreadId,
      projectId: groupId,
    } as const;
    const user = { kind: "user" } as const;

    // user: the UI reads the library; every other new tool is forbidden.
    const libraryRead = yield* service.libraryList({ projectId: groupId }, user);
    assert.equal(Array.isArray(libraryRead.entries), true);
    for (const exit of [
      yield* Effect.exit(
        service.remember({ requestId: "req-u-remember", projectId: groupId, note: "x" }, user),
      ),
      yield* Effect.exit(
        service.forget(
          { requestId: "req-u-forget", projectId: groupId, path: "memory/2026-01-01-x.md" },
          user,
        ),
      ),
      yield* Effect.exit(
        service.linkRepository(
          { requestId: "req-u-link", projectId: groupId, linkedProjectId: ordinaryId },
          user,
        ),
      ),
      yield* Effect.exit(
        service.libraryAdd(
          { requestId: "req-u-add", projectId: groupId, sourcePath: "a.txt" },
          user,
        ),
      ),
      yield* Effect.exit(service.listGroupThreads({ projectId: groupId }, user)),
    ]) {
      assert.equal(exit._tag, "Failure");
    }

    // unmanaged and foreign principals never touch the group.
    for (const principal of [unmanaged, foreignWorker] as const) {
      for (const exit of [
        yield* Effect.exit(
          service.remember(
            { requestId: "req-f-remember", projectId: groupId, note: "x" },
            principal,
          ),
        ),
        yield* Effect.exit(
          service.libraryAdd(
            { requestId: "req-f-add", projectId: groupId, sourcePath: "a.txt" },
            principal,
          ),
        ),
        yield* Effect.exit(service.listGroupThreads({ projectId: groupId }, principal)),
        yield* Effect.exit(
          service.linkRepository(
            { requestId: "req-f-link", projectId: groupId, linkedProjectId: ordinaryId },
            principal,
          ),
        ),
      ]) {
        assert.equal(exit._tag, "Failure");
      }
    }

    // group-member + worker: memory and library yes, link/list_threads no.
    const memberMemory = yield* service.remember(
      { requestId: "req-m-remember", projectId: groupId, note: "member note" },
      member,
    );
    assert.equal(memberMemory.updated, true);
    const workerMemory = yield* service.remember(
      { requestId: "req-w-remember", projectId: groupId, note: "worker note" },
      worker,
    );
    assert.equal(workerMemory.updated, true);
    for (const principal of [member, worker] as const) {
      assert.equal(
        (yield* Effect.exit(service.listGroupThreads({ projectId: groupId }, principal)))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(
          service.linkRepository(
            { requestId: "req-mw-link", projectId: groupId, linkedProjectId: ordinaryId },
            principal,
          ),
        ))._tag,
        "Failure",
      );
    }

    // coordinator: everything.
    const linked = yield* service.linkRepository(
      { requestId: "req-c-link", projectId: groupId, linkedProjectId: ordinaryId },
      coordinator,
    );
    assert.equal(linked.config?.linkedProjectIds?.includes(ordinaryId), true);
    const threads = yield* service.listGroupThreads({ projectId: groupId }, coordinator);
    assert.equal(Array.isArray(threads.threads), true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("remember writes a dated note + MEMORY.md line and dedupes repeats", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-mem-setup");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);
    const today = new Date().toISOString().slice(0, 10);

    const first = yield* service.remember(
      {
        requestId: "req-mem-1",
        projectId: groupId,
        note: "Releases go out on Tuesdays",
        title: "Release day",
      },
      coordinator,
    );
    assert.equal(first.path, `memory/${today}-release-day.md`);
    assert.equal(first.updated, true);
    assert.equal(first.deduplicated, false);

    const note = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: first.path,
    });
    assert.equal(Option.isSome(note), true);
    if (Option.isSome(note)) {
      assert.equal(note.value.content.includes("Releases go out on Tuesdays"), true);
      assert.equal(note.value.authorKind, "system");
    }

    const index = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    assert.equal(Option.isSome(index), true);
    if (Option.isSome(index)) {
      assert.equal(index.value.content.includes(`- [Release day](${first.path})`), true);
    }

    // A near-identical repeat refreshes the index line in place — no new file.
    const again = yield* service.remember(
      {
        requestId: "req-mem-2",
        projectId: groupId,
        note: "releases go out on tuesdays",
      },
      coordinator,
    );
    assert.equal(again.deduplicated, true);
    assert.equal(again.updated, false);
    assert.equal(again.path, first.path);
    const heads = yield* repository.listDocumentHeads(groupId);
    assert.equal(heads.filter((head) => head.logicalPath.startsWith(`memory/${today}-`)).length, 1);

    // forget removes the file and its index line.
    const forgotten = yield* service.forget(
      { requestId: "req-mem-3", projectId: groupId, path: first.path },
      coordinator,
    );
    assert.equal(forgotten.deleted, true);
    const gone = yield* repository.getDocumentHead(groupId, first.path);
    assert.equal(Option.isNone(gone), true);
    const indexAfter = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    assert.equal(Option.isSome(indexAfter), true);
    if (Option.isSome(indexAfter)) {
      assert.equal(indexAfter.value.content.includes(first.path), false);
    }
    // forget refuses non-memory paths and missing files.
    assert.equal(
      (yield* Effect.exit(
        service.forget(
          { requestId: "req-mem-4", projectId: groupId, path: "instructions.md" },
          coordinator,
        ),
      ))._tag,
      "Failure",
    );
    const missing = yield* service.forget(
      { requestId: "req-mem-5", projectId: groupId, path: `memory/${today}-nope.md` },
      coordinator,
    );
    assert.equal(missing.deleted, false);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("user memory notes are indexed into MEMORY.md like remember notes", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* configureTestGroup(service, "req-mem-notes-setup");
    const user = { kind: "user" as const };

    const saved = yield* service.writeDocument(
      {
        requestId: "req-note-1",
        projectId: groupId,
        logicalPath: "memory/notes/2026-09-22-releases-go-out-on-tuesdays.md",
        content: "# Releases\nReleases go out on Tuesdays.\n",
      },
      user,
    );
    assert.equal(saved.logicalPath, "memory/notes/2026-09-22-releases-go-out-on-tuesdays.md");

    const index = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    assert.equal(Option.isSome(index), true);
    if (Option.isSome(index)) {
      const line = `- [Releases](${saved.logicalPath}) — Releases go out on Tuesdays.`;
      assert.equal(index.value.content.includes(line), true);
    }

    // A note without a heading indexes under its first line of text.
    yield* service.writeDocument(
      {
        requestId: "req-note-2",
        projectId: groupId,
        logicalPath: "memory/notes/2026-09-22-standup-is-at-ten.md",
        content: "Standup is at ten.\nBring the notes file.\n",
      },
      user,
    );
    const indexAfter = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    assert.equal(Option.isSome(indexAfter), true);
    if (Option.isSome(indexAfter)) {
      assert.equal(
        indexAfter.value.content.includes(
          "- [Standup is at ten.](memory/notes/2026-09-22-standup-is-at-ten.md)",
        ),
        true,
      );
    }

    // Re-writing a note refreshes its index line in place — never duplicates it.
    yield* service.writeDocument(
      {
        requestId: "req-note-3",
        projectId: groupId,
        logicalPath: "memory/notes/2026-09-22-releases-go-out-on-tuesdays.md",
        content: "# Releases\nReleases moved to Wednesdays.\n",
      },
      user,
    );
    const indexFinal = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    assert.equal(Option.isSome(indexFinal), true);
    if (Option.isSome(indexFinal)) {
      const matches = indexFinal.value.content
        .split("\n")
        .filter((line) => line.includes("memory/notes/2026-09-22-releases-go-out-on-tuesdays.md"));
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.includes("Releases moved to Wednesdays."), true);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("linkRepository links by project id or workspace path and records activity", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-link-setup");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);

    const byId = yield* service.linkRepository(
      { requestId: "req-link-1", projectId: groupId, linkedProjectId: ordinaryId },
      coordinator,
    );
    assert.equal(byId.config?.linkedProjectIds?.includes(ordinaryId), true);
    const activity = yield* repository.listActivity({ projectId: groupId, limit: 20 });
    assert.equal(
      activity.some((item) => item.summary.includes("Linked repository")),
      true,
    );

    const byPath = yield* service.linkRepository(
      { requestId: "req-link-2", projectId: groupId, workspacePath: "/tmp/app" },
      coordinator,
    );
    assert.equal(byPath.config?.linkedProjectIds?.includes(ordinaryId), true);

    // Unknown workspace path, containers and self-linking are rejected.
    for (const input of [
      { requestId: "req-link-3", projectId: groupId, workspacePath: "/tmp/nothing" },
      { requestId: "req-link-4", projectId: groupId, linkedProjectId: groupId },
      { requestId: "req-link-5", projectId: groupId, linkedProjectId: groupId2 },
      { requestId: "req-link-6", projectId: groupId, linkedProjectId: studioId },
    ]) {
      assert.equal(
        (yield* Effect.exit(service.linkRepository(input, coordinator)))._tag,
        "Failure",
      );
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("libraryAdd copies in-workspace files and rejects escapes", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const serverConfig = yield* ServerConfig;
    const overview = yield* configureTestGroup(service, "req-lib-setup");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);

    // The group folder is the coordinator's workspace; the member thread gets
    // its own working directory — both under the tmp state dir, never the
    // real ~/Documents/Synara workspace roots.
    const groupFolder = path.join(serverConfig.stateDir, "group-folder");
    const memberWorkspace = path.join(serverConfig.stateDir, "member-workspace");
    yield* Effect.promise(() => fs.mkdir(path.join(groupFolder, "docs"), { recursive: true }));
    yield* Effect.promise(() => fs.mkdir(memberWorkspace, { recursive: true }));
    yield* Effect.promise(() =>
      fs.writeFile(path.join(memberWorkspace, "report.txt"), "quarterly report"),
    );
    harness.threadShells[groupMemberThreadId] = {
      projectId: groupId,
      title: "Group member chat",
      session: { status: "ready", updatedAt: now, lastError: null },
      workingDirectory: memberWorkspace,
    };
    harness.threadShells[overview.config!.coordinatorThreadId!] = {
      projectId: groupId,
      title: "Coordinator",
      session: null,
      workingDirectory: groupFolder,
    };
    const libraryRoot = yield* resolveLibraryRoot({
      stateDir: serverConfig.stateDir,
      projectId: groupId,
    });

    // member thread delivers a file from its own workspace.
    const added = yield* service.libraryAdd(
      {
        requestId: "req-lib-add-1",
        projectId: groupId,
        sourcePath: "report.txt",
      },
      memberPrincipal(),
    );
    assert.equal(added.path, "report.txt");
    assert.equal(added.commitSha, "0123456789abcdef0123456789abcdef01234567");
    const copied = yield* Effect.promise(() =>
      fs.readFile(path.join(libraryRoot, "report.txt"), "utf8"),
    );
    assert.equal(copied, "quarterly report");
    const listed = yield* service.libraryList({ projectId: groupId }, memberPrincipal());
    assert.equal(
      listed.entries.some((entry) => entry.name === "report.txt"),
      true,
    );

    // coordinator can deliver from the group folder too.
    yield* Effect.promise(() => fs.writeFile(path.join(groupFolder, "plan.md"), "plan"));
    const coordinatorAdd = yield* service.libraryAdd(
      {
        requestId: "req-lib-add-2",
        projectId: groupId,
        sourcePath: "plan.md",
        destinationPath: "notes/plan.md",
      },
      coordinator,
    );
    assert.equal(coordinatorAdd.path, "notes/plan.md");

    // A symlink inside the workspace that points outside it is rejected.
    const outsideFile = path.join(serverConfig.stateDir, "outside.txt");
    yield* Effect.promise(() => fs.writeFile(outsideFile, "secret"));
    yield* Effect.promise(() => fs.symlink(outsideFile, path.join(memberWorkspace, "escape.txt")));
    assert.equal(
      (yield* Effect.exit(
        service.libraryAdd(
          { requestId: "req-lib-add-3", projectId: groupId, sourcePath: "escape.txt" },
          memberPrincipal(),
        ),
      ))._tag,
      "Failure",
    );

    // Absolute paths outside the workspace and .git destinations are refused.
    assert.equal(
      (yield* Effect.exit(
        service.libraryAdd(
          {
            requestId: "req-lib-add-4",
            projectId: groupId,
            sourcePath: outsideFile,
          },
          memberPrincipal(),
        ),
      ))._tag,
      "Failure",
    );
    assert.equal(
      (yield* Effect.exit(
        service.libraryAdd(
          {
            requestId: "req-lib-add-5",
            projectId: groupId,
            sourcePath: "report.txt",
            destinationPath: ".git/config",
          },
          memberPrincipal(),
        ),
      ))._tag,
      "Failure",
    );

    // A thread from another group cannot reach this group's library.
    assert.equal(
      (yield* Effect.exit(
        service.libraryAdd(
          {
            requestId: "req-lib-add-6",
            projectId: groupId,
            sourcePath: "report.txt",
          },
          memberPrincipal(group2MemberThreadId, groupId2),
        ),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("listGroupThreads reports derived states to the coordinator", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-threads-setup");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);

    const runningThread = ThreadId.makeUnsafe("thread-running");
    const approvalThread = ThreadId.makeUnsafe("thread-approval");
    const prThread = ThreadId.makeUnsafe("thread-pr");
    for (const threadId of [runningThread, approvalThread, prThread]) {
      yield* repository.upsertThreadIndex({
        projectId: groupId,
        threadId,
        excluded: false,
        archived: false,
        summaryStatus: "pending",
        lastUpdatedAt: now,
        lastSummarizedAt: null,
      });
    }
    harness.threadShells[runningThread] = {
      projectId: groupId,
      title: "Runner",
      session: { status: "running", updatedAt: now, lastError: null },
      latestTurn: { state: "running", startedAt: now },
    };
    harness.threadShells[approvalThread] = {
      projectId: groupId,
      title: "Needs approval",
      session: { status: "ready", updatedAt: now, lastError: null },
      hasPendingApprovals: true,
    };
    harness.threadShells[prThread] = {
      projectId: groupId,
      title: "Opened a PR",
      session: { status: "ready", updatedAt: now, lastError: null },
      lastKnownPr: {
        url: "https://github.com/diliprt/synara/pull/7",
        state: "open",
        isDraft: false,
      },
    };

    const result = yield* service.listGroupThreads({ projectId: groupId }, coordinator);
    const byThread = new Map(result.threads.map((row) => [row.threadId, row]));
    assert.equal(byThread.get(runningThread)?.state, "working");
    assert.equal(byThread.get(approvalThread)?.state, "waiting");
    assert.equal(byThread.get(prThread)?.state, "review");
    assert.equal(
      byThread.get(prThread)?.pullRequestUrl,
      "https://github.com/diliprt/synara/pull/7",
    );
    assert.equal(byThread.get(prThread)?.projectTitle, "Alpha");
    // waiting sorts ahead of working ahead of review.
    const states = result.threads.map((row) => row.state);
    assert.deepEqual(states, ["waiting", "working", "review"]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("pause interrupts turns, blocks wakes, disables automations; resume restores", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-pause-setup");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);
    const automationId = AutomationId.makeUnsafe("automation-1");
    harness.automationDefinitions.push(
      { id: automationId, enabled: true, archivedAt: null, prompt: PROJECT_BOT_HEARTBEAT_PROMPT },
      {
        id: AutomationId.makeUnsafe("automation-2"),
        enabled: false,
        archivedAt: null,
        prompt: "x",
      },
    );
    yield* repository.upsertThreadIndex({
      projectId: groupId,
      threadId: groupMemberThreadId,
      excluded: false,
      archived: false,
      summaryStatus: "pending",
      lastUpdatedAt: now,
      lastSummarizedAt: null,
    });
    harness.threadShells[groupMemberThreadId] = {
      projectId: groupId,
      title: "Group member chat",
      session: { status: "running", updatedAt: now, lastError: null },
      latestTurn: { state: "running", startedAt: now },
    };

    // Only the user can pause.
    assert.equal(
      (yield* Effect.exit(
        service.pauseGroup({ requestId: "req-pause-x", projectId: groupId }, coordinator),
      ))._tag,
      "Failure",
    );
    const paused = yield* service.pauseGroup(
      { requestId: "req-pause-1", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(paused.config?.pausedAt !== null && paused.config?.pausedAt !== undefined, true);
    const interrupts = harness.dispatched.filter(
      (command) => command.type === "thread.turn.interrupt",
    );
    assert.equal(
      interrupts.some((command) => command.threadId === groupMemberThreadId),
      true,
    );
    // Only the previously-enabled automation was disabled.
    assert.equal(
      harness.automationUpdates.some(
        (update) => update.id === automationId && update.enabled === false,
      ),
      true,
    );
    assert.equal(
      harness.automationUpdates.some((update) => update.id === "automation-2"),
      false,
    );

    // A queued wake stays queued while paused.
    yield* repository.insertInboxEvent({
      id: ProjectInboxEventId.makeUnsafe("inbox-paused"),
      projectId: groupId,
      sourceThreadId: groupMemberThreadId,
      sourceEventId: "paused-alert",
      eventType: "worker.error",
      taskId: null,
      eligibleWake: true,
      createdAt: "2026-09-20T00:07:00.000Z",
    });
    yield* service.processPendingWakes(groupId);
    assert.equal(harness.runNowCalls.length, 0);

    const resumed = yield* service.resumeGroup(
      { requestId: "req-resume-1", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(resumed.config?.pausedAt ?? null, null);
    assert.equal(
      harness.automationUpdates.some(
        (update) => update.id === automationId && update.enabled === true,
      ),
      true,
    );
    // resume re-drives the pending wake.
    assert.equal(harness.runNowCalls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("archive hides the group and unarchive restores it", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-archive-setup");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const automationId = AutomationId.makeUnsafe("automation-1");
    harness.automationDefinitions.push({
      id: automationId,
      enabled: true,
      archivedAt: null,
      prompt: PROJECT_BOT_HEARTBEAT_PROMPT,
    });
    yield* repository.upsertThreadIndex({
      projectId: groupId,
      threadId: groupMemberThreadId,
      excluded: false,
      archived: false,
      summaryStatus: "pending",
      lastUpdatedAt: now,
      lastSummarizedAt: null,
    });
    // A worker indexed under the group but living in a linked repo's project
    // must not be archived/unarchived with the group's own threads.
    const linkedWorkerThreadId = ThreadId.makeUnsafe("thread-linked-worker-arch");
    yield* repository.upsertThreadIndex({
      projectId: groupId,
      threadId: linkedWorkerThreadId,
      excluded: false,
      archived: false,
      summaryStatus: "pending",
      lastUpdatedAt: now,
      lastSummarizedAt: null,
    });
    harness.threadShells[linkedWorkerThreadId] = {
      projectId: ordinaryId,
      title: "Linked repo worker",
      session: { status: "running", updatedAt: now, lastError: null },
      latestTurn: { state: "running", startedAt: now },
    };

    assert.equal(
      (yield* Effect.exit(
        service.archiveGroup({ requestId: "req-arch-x", projectId: groupId }, coordinator),
      ))._tag,
      "Failure",
    );
    const archived = yield* service.archiveGroup(
      { requestId: "req-arch-1", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(
      archived.config?.archivedAt !== null && archived.config?.archivedAt !== undefined,
      true,
    );
    const archiveCommands = new Set(
      harness.dispatched
        .filter((command) => command.type === "thread.archive")
        .map((command) => command.threadId),
    );
    assert.equal(archiveCommands.has(coordinatorThreadId), true);
    assert.equal(archiveCommands.has(groupMemberThreadId), true);
    assert.equal(archiveCommands.has(linkedWorkerThreadId), false);
    assert.equal(
      harness.automationUpdates.some(
        (update) => update.id === automationId && update.enabled === false,
      ),
      true,
    );

    harness.threadShells[groupMemberThreadId] = {
      ...harness.threadShells[groupMemberThreadId]!,
      archivedAt: now,
    };
    // The linked worker may itself be archived by its own repo — the group
    // unarchive must still not reach into that repo's project.
    harness.threadShells[linkedWorkerThreadId] = {
      ...harness.threadShells[linkedWorkerThreadId]!,
      archivedAt: now,
    };
    const restored = yield* service.unarchiveGroup(
      { requestId: "req-unarch-1", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(restored.config?.archivedAt ?? null, null);
    const unarchiveCommands = new Set(
      harness.dispatched
        .filter((command) => command.type === "thread.unarchive")
        .map((command) => command.threadId),
    );
    assert.equal(unarchiveCommands.has(coordinatorThreadId), true);
    assert.equal(unarchiveCommands.has(groupMemberThreadId), true);
    assert.equal(unarchiveCommands.has(linkedWorkerThreadId), false);
    assert.equal(
      harness.automationUpdates.some(
        (update) => update.id === automationId && update.enabled === true,
      ),
      true,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("delete removes group data, keeps custom libraries and linked repos", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const serverConfig = yield* ServerConfig;
    const customLibrary = path.join(serverConfig.stateDir, "group-library-custom");
    yield* Effect.promise(() => fs.mkdir(customLibrary, { recursive: true }));
    const overview = yield* configureTestGroup(service, "req-del-setup", {
      libraryPath: customLibrary,
    });
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);
    // Listing initializes the Synara marker so the custom root counts as
    // managed — a markerless non-empty folder is never treated as a library.
    yield* service.libraryList({ projectId: groupId }, { kind: "user" });
    yield* Effect.promise(() => fs.writeFile(path.join(customLibrary, "seed.txt"), "keep me"));
    harness.automationDefinitions.push({
      id: "automation-1",
      enabled: true,
      archivedAt: null,
      prompt: PROJECT_BOT_HEARTBEAT_PROMPT,
    });

    yield* service.linkRepository(
      { requestId: "req-del-link", projectId: groupId, linkedProjectId: ordinaryId },
      coordinator,
    );
    yield* repository.upsertThreadIndex({
      projectId: groupId,
      threadId: groupMemberThreadId,
      excluded: false,
      archived: false,
      summaryStatus: "covered",
      lastUpdatedAt: now,
      lastSummarizedAt: now,
    });
    harness.threadShells[groupMemberThreadId] = {
      projectId: groupId,
      title: "Member",
      workingDirectory: `${serverConfig.stateDir}/member`,
      session: null,
    };
    // A worker whose home project is the LINKED repo: it shows up in the
    // group listing via its task assignment, but it is not the group's thread
    // to kill.
    const linkedWorkerThreadId = ThreadId.makeUnsafe("thread-linked-worker-del");
    yield* repository.saveGoal(
      {
        id: ProjectGoalId.makeUnsafe("goal-del"),
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
        id: ProjectTaskId.makeUnsafe("task-del"),
        projectId: groupId,
        goalId: ProjectGoalId.makeUnsafe("goal-del"),
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
    harness.threadShells[linkedWorkerThreadId] = {
      projectId: ordinaryId,
      title: "Linked repo worker",
      session: { status: "running", updatedAt: now, lastError: null },
      latestTurn: { state: "running", startedAt: now },
    };

    assert.equal(
      (yield* Effect.exit(
        service.deleteGroup(
          { requestId: "req-del-x", projectId: groupId, confirmName: "Alpha" },
          coordinator,
        ),
      ))._tag,
      "Failure",
    );
    // The typed-name confirmation is verified server-side, not just in the UI.
    assert.equal(
      (yield* Effect.exit(
        service.deleteGroup(
          { requestId: "req-del-name", projectId: groupId, confirmName: "Not the name" },
          { kind: "user" },
        ),
      ))._tag,
      "Failure",
    );
    const result = yield* service.deleteGroup(
      { requestId: "req-del-1", projectId: groupId, confirmName: "Alpha" },
      { kind: "user" },
    );
    assert.equal(result.deletedProjectId, groupId);

    // The group's coordinator data is gone; linked repos are untouched.
    const config = yield* repository.getConfig(groupId);
    assert.equal(Option.isNone(config), true);
    // project.delete only accepts threadless projects: every group thread
    // (coordinator + members) is deleted first — but never a linked-repo
    // worker thread.
    const threadDeletes = harness.dispatched.filter((command) => command.type === "thread.delete");
    assert.deepEqual(
      threadDeletes.map((command) => command.threadId).toSorted(),
      [overview.config!.coordinatorThreadId!, groupMemberThreadId].toSorted(),
    );
    const deletes = harness.dispatched.filter((command) => command.type === "project.delete");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0]!.projectId, groupId);
    assert.equal(
      harness.dispatched.some(
        (command) => command.type === "project.delete" && command.projectId === ordinaryId,
      ),
      false,
    );
    // Threads are deleted before the project — a refused thread.delete aborts
    // the delete while everything is still intact.
    const projectDeleteIndex = harness.dispatched.findIndex(
      (command) => command.type === "project.delete",
    );
    const lastThreadDeleteIndex = harness.dispatched.findLastIndex(
      (command) => command.type === "thread.delete",
    );
    assert.equal(lastThreadDeleteIndex < projectDeleteIndex, true);
    assert.equal(harness.automationDeletes.includes("automation-1"), true);

    // A user-chosen library folder is never moved or deleted — it is left in
    // place and reported.
    assert.equal(result.libraryLeftOnDiskPath, customLibrary);
    const seed = yield* Effect.promise(() =>
      fs.readFile(path.join(customLibrary, "seed.txt"), "utf8"),
    );
    assert.equal(seed, "keep me");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("delete moves the managed library into the injected trash dir", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const serverConfig = yield* ServerConfig;
    const overview = yield* configureTestGroup(service, "req-managed-lib");
    assert.equal(overview.configured, true);
    assert.equal(serverConfig.trashDir !== undefined && serverConfig.trashDir !== null, true);
    // Listing initializes the managed library root under project-context.
    yield* service.libraryList({ projectId: groupId }, { kind: "user" });
    const libraryRoot = yield* resolveLibraryRoot({
      stateDir: serverConfig.stateDir,
      projectId: groupId,
    });
    yield* Effect.promise(() => fs.writeFile(path.join(libraryRoot, "seed.txt"), "keep me"));

    const result = yield* service.deleteGroup(
      { requestId: "req-managed-del", projectId: groupId, confirmName: "Alpha" },
      { kind: "user" },
    );
    assert.equal(result.deletedProjectId, groupId);
    assert.equal(result.libraryLeftOnDiskPath, null);

    // The managed library is renamed into the configured trash dir — a temp
    // dir in tests, never the real ~/.Trash.
    const moved = yield* Effect.promise(() => fs.readdir(serverConfig.trashDir!));
    assert.equal(moved.length > 0, true);
    const seed = yield* Effect.promise(() =>
      fs.readFile(path.join(serverConfig.trashDir!, moved[0]!, "seed.txt"), "utf8"),
    );
    assert.equal(seed, "keep me");
    const stillThere = yield* Effect.promise(() =>
      fs
        .access(libraryRoot)
        .then(() => true)
        .catch(() => false),
    );
    assert.equal(stillThere, false);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("delete aborts atomically when a group thread refuses to delete", () => {
  const harness = makeTestLayer({ failCommandTypes: ["thread.delete"] });
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const serverConfig = yield* ServerConfig;
    const overview = yield* configureTestGroup(service, "req-atomic-setup");
    yield* repository.upsertThreadIndex({
      projectId: groupId,
      threadId: groupMemberThreadId,
      excluded: false,
      archived: false,
      summaryStatus: "covered",
      lastUpdatedAt: now,
      lastSummarizedAt: now,
    });
    yield* service.libraryList({ projectId: groupId }, { kind: "user" });
    const libraryRoot = yield* resolveLibraryRoot({
      stateDir: serverConfig.stateDir,
      projectId: groupId,
    });
    yield* Effect.promise(() => fs.writeFile(path.join(libraryRoot, "seed.txt"), "keep me"));

    const exit = yield* Effect.exit(
      service.deleteGroup(
        { requestId: "req-atomic-del", projectId: groupId, confirmName: "Alpha" },
        { kind: "user" },
      ),
    );
    assert.equal(exit._tag, "Failure");

    // Nothing was torn down: the project delete never ran, the coordinator
    // config and the library are all still in place.
    assert.equal(
      harness.dispatched.some((command) => command.type === "project.delete"),
      false,
    );
    const config = yield* repository.getConfig(groupId);
    assert.equal(Option.isSome(config), true);
    const index = yield* repository.listThreadIndex(groupId);
    assert.equal(
      index.some((entry) => entry.threadId === groupMemberThreadId),
      true,
    );
    const stillThere = yield* Effect.promise(() =>
      fs
        .access(libraryRoot)
        .then(() => true)
        .catch(() => false),
    );
    assert.equal(stillThere, true);
    assert.equal(overview.config?.coordinatorThreadId != null, true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("configure preserves pause state and pause-disabled automations", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* configureTestGroup(service, "req-cfg-setup");
    const automationId = AutomationId.makeUnsafe("automation-1");
    harness.automationDefinitions.push({
      id: automationId,
      enabled: true,
      archivedAt: null,
      prompt: PROJECT_BOT_HEARTBEAT_PROMPT,
    });

    const paused = yield* service.pauseGroup(
      { requestId: "req-cfg-pause", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(paused.config?.pausedAt != null, true);
    assert.equal(
      paused.config?.pausedAutomationIds?.some((id) => String(id) === String(automationId)),
      true,
    );

    // Saving settings must not un-pause the group or forget which automations
    // pause disabled.
    const saved = yield* service.configure(
      {
        requestId: "req-cfg-rename",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        coordinatorName: "Renamed Bot",
      },
      { kind: "user" },
    );
    assert.equal(saved.config?.coordinatorName, "Renamed Bot");
    assert.equal(saved.config?.pausedAt != null, true);
    assert.equal(
      saved.config?.pausedAutomationIds?.some((id) => String(id) === String(automationId)),
      true,
    );

    harness.automationUpdates.length = 0;
    const resumed = yield* service.resumeGroup(
      { requestId: "req-cfg-resume", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(resumed.config?.pausedAt ?? null, null);
    assert.equal(
      harness.automationUpdates.some(
        (update) => update.id === String(automationId) && update.enabled === true,
      ),
      true,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("remember allocates -2/-3 paths for distinct same-title notes", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-mem-suffix");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);
    const today = new Date().toISOString().slice(0, 10);

    const first = yield* service.remember(
      { requestId: "req-suf-1", projectId: groupId, note: "Ship it today.", title: "Release day" },
      coordinator,
    );
    const second = yield* service.remember(
      {
        requestId: "req-suf-2",
        projectId: groupId,
        note: "Push slipped to Friday.",
        title: "Release day",
      },
      coordinator,
    );
    const third = yield* service.remember(
      {
        requestId: "req-suf-3",
        projectId: groupId,
        note: "Hotfix needed first.",
        title: "Release day",
      },
      coordinator,
    );
    assert.equal(first.path, `memory/${today}-release-day.md`);
    assert.equal(second.path, `memory/${today}-release-day-2.md`);
    assert.equal(third.path, `memory/${today}-release-day-3.md`);

    // All three notes exist with their own content — nothing was overwritten.
    for (const [logicalPath, fragment] of [
      [first.path, "Ship it today."],
      [second.path, "Push slipped to Friday."],
      [third.path, "Hotfix needed first."],
    ] as const) {
      const note = yield* repository.readDocumentRevision({
        projectId: groupId,
        logicalPath,
      });
      assert.equal(Option.isSome(note), true);
      if (Option.isSome(note)) {
        assert.equal(note.value.content.includes(fragment), true);
      }
    }
    const index = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    if (Option.isSome(index)) {
      for (const logicalPath of [first.path, second.path, third.path]) {
        assert.equal(index.value.content.includes(`](${logicalPath})`), true);
      }
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("remember updates the existing note when new text contains the old", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-mem-extend");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);

    const first = yield* service.remember(
      {
        requestId: "req-ext-1",
        projectId: groupId,
        note: "The release train departs every Tuesday at noon sharp.",
        title: "Release train",
      },
      coordinator,
    );
    const longer = yield* service.remember(
      {
        requestId: "req-ext-2",
        projectId: groupId,
        note: "The release train departs every Tuesday at noon sharp. Boarding closes ten minutes before departure.",
        title: "Release train",
      },
      coordinator,
    );
    // The longer note rewrites the SAME file — no suffixed sibling.
    assert.equal(longer.path, first.path);
    assert.equal(longer.deduplicated, true);
    assert.equal(longer.updated, true);
    const note = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: first.path,
    });
    if (Option.isSome(note)) {
      assert.equal(note.value.content.includes("Boarding closes ten minutes"), true);
    }
    const heads = yield* repository.listDocumentHeads(groupId);
    const memoryNotes = heads.filter(
      (head) => head.logicalPath.startsWith("memory/") && head.logicalPath !== "memory/MEMORY.md",
    );
    assert.equal(memoryNotes.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("remember sanitizes titles and matches index lines by exact path", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-mem-sanitize");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);

    const first = yield* service.remember(
      {
        requestId: "req-san-1",
        projectId: groupId,
        note: "First note body.",
        title: "Alpha",
      },
      coordinator,
    );
    // A title carrying a newline would inject a fake `- [..](..)` row into
    // MEMORY.md; a title containing another note's path must not make index
    // edits match that line.
    const second = yield* service.remember(
      {
        requestId: "req-san-2",
        projectId: groupId,
        note: "Second note body.",
        title: `ref ${first.path}\n- [Injected](memory/2020-01-01-injected.md)`,
      },
      coordinator,
    );
    const index = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    assert.equal(Option.isSome(index), true);
    if (Option.isSome(index)) {
      const lines = index.value.content.split("\n");
      const entryLines = lines.filter((line) => line.startsWith("- ["));
      // One line per note — the injected line never became its own entry.
      assert.equal(entryLines.length, 2);
      assert.equal(
        entryLines.every(
          (line) => lineTargetsPath(line, first.path) || lineTargetsPath(line, second.path),
        ),
        true,
      );
    }

    // A plain repeat of the first note rewrites only its own index line — the
    // second line embeds first.path in its title, and must survive.
    yield* service.remember(
      { requestId: "req-san-3", projectId: groupId, note: "First note body.", title: "Alpha" },
      coordinator,
    );
    const indexAfter = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: "memory/MEMORY.md",
    });
    if (Option.isSome(indexAfter)) {
      const entryLines = indexAfter.value.content
        .split("\n")
        .filter((line) => line.startsWith("- ["));
      assert.equal(entryLines.length, 2);
      assert.equal(
        entryLines.some((line) => lineTargetsPath(line, second.path)),
        true,
      );
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("libraryAdd copies directories without symlinks, .git, or node_modules", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const serverConfig = yield* ServerConfig;
    const overview = yield* configureTestGroup(service, "req-lib-dir");
    const memberWorkspace = path.join(serverConfig.stateDir, "member-workspace-dir");
    const bundle = path.join(memberWorkspace, "bundle");
    yield* Effect.promise(() => fs.mkdir(path.join(bundle, ".git"), { recursive: true }));
    yield* Effect.promise(() =>
      fs.mkdir(path.join(bundle, "node_modules", "pkg"), { recursive: true }),
    );
    yield* Effect.promise(() => fs.writeFile(path.join(bundle, "keep.txt"), "keep"));
    yield* Effect.promise(() =>
      fs.writeFile(path.join(bundle, ".git", "config"), "[core] bare = false"),
    );
    yield* Effect.promise(() =>
      fs.writeFile(path.join(bundle, "node_modules", "pkg", "index.js"), "module.exports = 1;"),
    );
    const outsideFile = path.join(serverConfig.stateDir, "outside-secret.txt");
    yield* Effect.promise(() => fs.writeFile(outsideFile, "secret"));
    yield* Effect.promise(() => fs.symlink(outsideFile, path.join(bundle, "escape.txt")));
    harness.threadShells[groupMemberThreadId] = {
      projectId: groupId,
      title: "Group member chat",
      session: { status: "ready", updatedAt: now, lastError: null },
      workingDirectory: memberWorkspace,
    };
    const libraryRoot = yield* resolveLibraryRoot({
      stateDir: serverConfig.stateDir,
      projectId: groupId,
    });

    const added = yield* service.libraryAdd(
      { requestId: "req-lib-dir-add", projectId: groupId, sourcePath: "bundle" },
      memberPrincipal(),
    );
    assert.equal(added.path, "bundle");
    const copied = yield* Effect.promise(() =>
      fs.readFile(path.join(libraryRoot, "bundle", "keep.txt"), "utf8"),
    );
    assert.equal(copied, "keep");
    for (const skipped of ["escape.txt", ".git", "node_modules"]) {
      const exists = yield* Effect.promise(() =>
        fs
          .access(path.join(libraryRoot, "bundle", skipped))
          .then(() => true)
          .catch(() => false),
      );
      assert.equal(exists, false, `expected ${skipped} to be skipped`);
    }
    assert.equal(overview.config?.coordinatorThreadId != null, true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses coordinator turns while the group is paused or archived", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* configureTestGroup(service, "req-gate-turns");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;

    yield* service.assertGroupCoordinatorTurnAllowed({ threadId: coordinatorThreadId });
    // Threads that are not a group coordinator pass through unconditionally.
    yield* service.assertGroupCoordinatorTurnAllowed({ threadId: groupMemberThreadId });

    yield* service.pauseGroup(
      { requestId: "req-gate-pause", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(
      (yield* Effect.exit(
        service.assertGroupCoordinatorTurnAllowed({ threadId: coordinatorThreadId }),
      ))._tag,
      "Failure",
    );
    yield* service.resumeGroup(
      { requestId: "req-gate-resume", projectId: groupId },
      { kind: "user" },
    );
    yield* service.assertGroupCoordinatorTurnAllowed({ threadId: coordinatorThreadId });
    yield* service.archiveGroup(
      { requestId: "req-gate-arch", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(
      (yield* Effect.exit(
        service.assertGroupCoordinatorTurnAllowed({ threadId: coordinatorThreadId }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("restartCoordinator stops the provider session and re-fires the heartbeat", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* configureTestGroup(service, "req-restart-setup");
    const coordinator = coordinatorPrincipal(overview.config!.coordinatorThreadId!);
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;

    assert.equal(
      (yield* Effect.exit(
        service.restartCoordinator({ requestId: "req-restart-x", projectId: groupId }, coordinator),
      ))._tag,
      "Failure",
    );
    yield* service.restartCoordinator(
      { requestId: "req-restart-1", projectId: groupId },
      { kind: "user" },
    );
    const stops = harness.dispatched.filter((command) => command.type === "thread.session.stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0]!.threadId, coordinatorThreadId);
    assert.equal(harness.runNowCalls.length, 1);

    // A paused group refuses the restart until it is resumed.
    yield* service.pauseGroup(
      { requestId: "req-restart-pause", projectId: groupId },
      { kind: "user" },
    );
    assert.equal(
      (yield* Effect.exit(
        service.restartCoordinator(
          { requestId: "req-restart-2", projectId: groupId },
          { kind: "user" },
        ),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("upgrades a stock playbook but never a user-edited one", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-playbook-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;

    // Seed already wrote the current default — simulate the previous default
    // with a system-authored revision that predates this playbook.
    yield* repository.writeDocument({
      revision: {
        id: ProjectDocumentRevisionId.makeUnsafe("doc-old-default"),
        projectId: groupId,
        logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
        revision: 2,
        content: "# Old default playbook\n\nFollow the project rules.\n",
        contentHash: "old-default-hash",
        authorKind: "system",
        authorThreadId: null,
        sources: [],
        createdAt: now,
      },
      expectedRevision: 1,
      diskHash: "old-default-hash",
    });
    yield* service.formatContextPacketForTurn(coordinatorThreadId);
    const upgraded = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
    });
    assert.equal(Option.isSome(upgraded), true);
    if (Option.isSome(upgraded)) {
      assert.equal(upgraded.value.content, PROJECT_BOT_PLAYBOOK);
    }

    // A user-authored playbook is left alone.
    const head = yield* repository.getDocumentHead(groupId, PROJECT_BOT_PLAYBOOK_PATH);
    const userRevision = (Option.isSome(head) ? head.value.revision : 2) + 1;
    yield* repository.writeDocument({
      revision: {
        id: ProjectDocumentRevisionId.makeUnsafe("doc-user-edit"),
        projectId: groupId,
        logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
        revision: userRevision,
        content: "# My custom coordinator rules\n",
        contentHash: "user-edit-hash",
        authorKind: "user",
        authorThreadId: null,
        sources: [],
        createdAt: now,
      },
      expectedRevision: userRevision - 1,
      diskHash: "user-edit-hash",
    });
    yield* service.formatContextPacketForTurn(coordinatorThreadId);
    const kept = yield* repository.readDocumentRevision({
      projectId: groupId,
      logicalPath: PROJECT_BOT_PLAYBOOK_PATH,
    });
    assert.equal(Option.isSome(kept), true);
    if (Option.isSome(kept)) {
      assert.equal(kept.value.content, "# My custom coordinator rules\n");
    }
  }).pipe(Effect.provide(harness.layer));
});
