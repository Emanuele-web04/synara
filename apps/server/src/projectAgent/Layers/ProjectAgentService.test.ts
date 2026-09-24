import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  DEFAULT_SERVER_SETTINGS,
  ProjectActivityId,
  ProjectDocumentRevisionId,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEventId,
  ProjectTaskId,
  ThreadId,
  type OrchestrationCommand,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
} from "@synara/contracts";
import { MEMORY_AUTO_DOCUMENT_PATH, memoryThreadDocumentPath } from "@synara/shared/projectAgent";
import { Cause, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";

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
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import type { ProviderSession } from "@synara/contracts";
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
  readonly disabledProviders?: ReadonlyArray<ProviderKind>;
  readonly unavailableProviders?: ReadonlyArray<ProviderKind>;
  readonly providerSessions?: ReadonlyArray<ProviderSession>;
}) {
  const threadShells: Record<
    string,
    {
      projectId: ProjectId;
      title: string;
      session: {
        status: string;
        updatedAt: string;
        lastError: string | null;
        activeTurnId?: string | null;
        lastActivityAt?: string | null;
        lastProgressAt?: string | null;
      } | null;
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
  // Thread detail stubs for code paths that hydrate messages (worker reports,
  // coordinator check-in classification). Shells alone are enough elsewhere.
  const threadDetails: Record<
    string,
    {
      messages: Array<{
        id: string;
        role: string;
        text: string;
        turnId?: string | null;
        dispatchOrigin?: string | null;
      }>;
    }
  > = {};
  const dispatched: OrchestrationCommand[] = [];
  const automationDefinitions: Array<{
    readonly id: string;
    readonly enabled: boolean;
    readonly archivedAt: string | null;
    readonly prompt: string;
  }> = [];
  const automationUpdates: Array<{
    readonly id: string;
    readonly enabled?: boolean;
    readonly modelSelection?: unknown;
  }> = [];
  const automationDeletes: string[] = [];
  const runNowCalls: string[] = [];
  const automationRuns: Array<{ readonly id: string }> = [];
  const digestGenerationInputs: unknown[] = [];
  let failFirstImport = options?.failFirstImport === true;
  let shellBatchCalls = 0;
  // Live provider-session snapshot the health loop consults for dead-session
  // detection, and durable in-flight tool rows the liveness tracking writes.
  const providerSessions: ProviderSession[] = [...(options?.providerSessions ?? [])];
  const toolInFlightByThread: Record<
    string,
    Array<{ itemId: string; turnId: string | null; startedAt: string }>
  > = {};
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
        getThreadDetailById: (threadId: ThreadId) =>
          Effect.succeed(
            threadId in threadDetails
              ? Option.some(threadDetails[threadId] as never)
              : Option.none(),
          ),
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
  const serverSettings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      ...Object.fromEntries(
        (options?.disabledProviders ?? []).map((provider) => [
          provider,
          { ...DEFAULT_SERVER_SETTINGS.providers[provider], enabled: false },
        ]),
      ),
    },
  };
  const providerStatuses: ServerProviderStatus[] = (
    Object.keys(DEFAULT_SERVER_SETTINGS.providers) as ProviderKind[]
  ).map((provider) => {
    const unavailable = (options?.unavailableProviders ?? []).includes(provider);
    return {
      provider,
      status: unavailable ? "error" : "ready",
      available: !unavailable,
      authStatus: "authenticated",
      checkedAt: now,
      message: unavailable ? `${provider} CLI is not installed or not on PATH.` : undefined,
    };
  });
  const serverSettingsLayer = Layer.succeed(ServerSettingsService, {
    getSettings: Effect.succeed(serverSettings),
  } as unknown as ServerSettingsService["Service"]);
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.succeed(providerStatuses),
  } as unknown as ProviderHealth["Service"]);
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
    update: (input: {
      readonly id: string;
      readonly enabled?: boolean;
      readonly modelSelection?: unknown;
    }) => {
      automationUpdates.push({
        id: String(input.id),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
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
    digestGenerationInputs,
    threadShells,
    threadDetails,
    providerSessions,
    toolInFlightByThread,
    shellBatchCalls: () => shellBatchCalls,
    layer: ProjectAgentServiceLive.pipe(
      Layer.provide(snapshotLayer),
      Layer.provide(orchestrationLayer),
      Layer.provide(automationLayer),
      Layer.provide(serverSettingsLayer),
      Layer.provide(providerHealthLayer),
      Layer.provide(
        Layer.succeed(TextGeneration, {
          generateProjectDigest: (input: unknown) => {
            digestGenerationInputs.push(input);
            return Effect.succeed({ summary: "Digest refreshed by test.", focusItems: [] });
          },
        } as unknown as TextGeneration["Service"]),
      ),
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
      Layer.provide(
        Layer.succeed(ProviderService, {
          listSessions: () => Effect.succeed([...providerSessions]),
        } as unknown as ProviderService["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProjectionThreadSessionRepository, {
          getToolInFlight: (input: { threadId: string }) =>
            Effect.succeed(
              (toolInFlightByThread[input.threadId] ?? []).map((row) => ({
                itemId: row.itemId,
                turnId: row.turnId,
                startedAt: row.startedAt,
              })),
            ),
        } as unknown as ProjectionThreadSessionRepository["Service"]),
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

it.effect("applies a saved coordinator model to the live thread and heartbeat", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const first = yield* service.configure(
      {
        requestId: "req-model-1",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const coordinatorThreadId = first.config?.coordinatorThreadId;
    assert.isNotNull(coordinatorThreadId);
    harness.dispatched.length = 0;
    harness.runNowCalls.length = 0;
    harness.automationUpdates.length = 0;

    const nextModel = { provider: "claudeAgent" as const, model: "claude-sonnet-4-6" };
    yield* service.configure(
      {
        requestId: "req-model-2",
        projectId: groupId,
        coordinatorModelSelection: nextModel,
      },
      { kind: "user" },
    );

    // The stored thread selection becomes the rebind signal the reactor
    // consumes: its own meta-updated path restarts the session on the new
    // provider and registers the prior-transcript bootstrap. An explicit
    // thread.session.stop would run the stop cleanup AFTER that registration
    // and wipe the bootstrap just created — so configure must not send one;
    // a check-in then runs the new model immediately.
    const metaUpdate = harness.dispatched.find(
      (command) => command.type === "thread.meta.update" && command.modelSelection !== undefined,
    );
    assert.isOk(metaUpdate);
    if (metaUpdate?.type !== "thread.meta.update") {
      assert.fail("expected a thread.meta.update dispatch");
    }
    assert.equal(metaUpdate.threadId, coordinatorThreadId);
    assert.deepEqual(metaUpdate.modelSelection, nextModel);
    assert.equal(
      harness.dispatched.some((command) => command.type === "thread.session.stop"),
      false,
    );
    assert.deepEqual(harness.runNowCalls, ["automation-1"]);
    assert.deepEqual(harness.automationUpdates, [
      { id: "automation-1", modelSelection: nextModel },
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not stop the session when the coordinator model keeps the same provider", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-model-same-1",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    harness.dispatched.length = 0;
    harness.runNowCalls.length = 0;

    const nextModel = { provider: "codex" as const, model: "gpt-5.3-codex" };
    yield* service.configure(
      {
        requestId: "req-model-same-2",
        projectId: groupId,
        coordinatorModelSelection: nextModel,
      },
      { kind: "user" },
    );

    assert.equal(
      harness.dispatched.some((command) => command.type === "thread.session.stop"),
      false,
    );
    const metaUpdate = harness.dispatched.find(
      (command) => command.type === "thread.meta.update" && command.modelSelection !== undefined,
    );
    assert.isOk(metaUpdate);
    if (metaUpdate?.type !== "thread.meta.update") {
      assert.fail("expected a thread.meta.update dispatch");
    }
    assert.deepEqual(metaUpdate.modelSelection, nextModel);
    assert.deepEqual(harness.runNowCalls, ["automation-1"]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("skips the model apply block when the coordinator model is unchanged", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-model-same-3",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    harness.dispatched.length = 0;
    harness.runNowCalls.length = 0;
    harness.automationUpdates.length = 0;

    yield* service.configure(
      {
        requestId: "req-model-same-4",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );

    assert.equal(
      harness.dispatched.some(
        (command) => command.type === "thread.meta.update" && command.modelSelection !== undefined,
      ),
      false,
    );
    assert.equal(
      harness.dispatched.some((command) => command.type === "thread.session.stop"),
      false,
    );
    assert.deepEqual(harness.runNowCalls, []);
    assert.deepEqual(
      harness.automationUpdates.filter((update) => update.modelSelection !== undefined),
      [],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a coordinator model whose provider is disabled in settings", () => {
  const harness = makeTestLayer({ disabledProviders: ["claudeAgent"] });
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* service.configure(
      {
        requestId: "req-disabled-provider-1",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    harness.dispatched.length = 0;
    harness.runNowCalls.length = 0;

    const error = yield* Effect.flip(
      service.configure(
        {
          requestId: "req-disabled-provider-2",
          projectId: groupId,
          coordinatorModelSelection: {
            provider: "claudeAgent" as const,
            model: "claude-sonnet-4-6",
          },
        },
        { kind: "user" },
      ),
    );

    assert.match(error.message, /disabled in Settings > Providers/);
    // The old binding survives: no rebind signal was stored or dispatched and
    // no extra check-in was queued.
    assert.equal(
      harness.dispatched.some((command) => command.type === "thread.meta.update"),
      false,
    );
    const stored = yield* repository.getConfig(groupId);
    assert.isTrue(Option.isSome(stored));
    if (Option.isSome(stored)) {
      assert.deepEqual(stored.value.coordinatorModelSelection, modelSelection);
    }
    assert.deepEqual(harness.runNowCalls, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a coordinator model whose provider is not installed", () => {
  const harness = makeTestLayer({ unavailableProviders: ["grok"] });
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    yield* service.configure(
      {
        requestId: "req-unavailable-provider-1",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    harness.dispatched.length = 0;
    harness.runNowCalls.length = 0;

    const error = yield* Effect.flip(
      service.configure(
        {
          requestId: "req-unavailable-provider-2",
          projectId: groupId,
          coordinatorModelSelection: { provider: "grok" as const, model: "grok-code-fast-1" },
        },
        { kind: "user" },
      ),
    );

    assert.match(error.message, /not installed or not on PATH/);
    assert.equal(
      harness.dispatched.some((command) => command.type === "thread.meta.update"),
      false,
    );
    assert.deepEqual(harness.runNowCalls, []);
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
      eventType: "user-input.requested",
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

it.effect("refreshes the digest when the coordinator's own turn settles", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* service.configure(
      {
        requestId: "req-coordinator-settle",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
      },
      { kind: "user" },
    );
    const coordinatorThreadId = overview.config?.coordinatorThreadId;
    assert.ok(coordinatorThreadId);
    const seeded = yield* repository.getDigest(groupId);
    assert.equal(Option.isSome(seeded) ? seeded.value.summary : null, "Coordinator is ready.");
    // A coordinator settle records the wake-skip activity and must re-arm the
    // debounced digest — the Focus card kept the seeded summary when it did not.
    yield* service.ingestSettledThreadEvent({
      threadId: coordinatorThreadId,
      sourceEventId: "coordinator-settle-1",
      eventType: "thread.turn-diff-completed",
      createdAt: now,
    });
    yield* TestClock.adjust("61 seconds");
    let digest: Option.Option<{ summary: string }> = Option.none();
    for (let i = 0; i < 100 && Option.isNone(digest); i += 1) {
      const found = yield* repository.getDigest(groupId);
      if (Option.isSome(found) && found.value.summary === "Digest refreshed by test.") {
        digest = found;
      } else {
        // The debounce fiber runs real (SQLite) work the test clock skips; let
        // the microtask queue drain so it can land.
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      }
    }
    assert.equal(Option.isSome(digest), true);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

it.effect("reports member threads, linked repos, and setup flags in summaries", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* service.configure(
      {
        requestId: "req-summary-fields",
        projectId: groupId,
        coordinatorModelSelection: modelSelection,
        // The dialog writes the goal text onto the config — hasGoal must see it
        // even before any goal row is authorized.
        goal: "Ship it",
      },
      { kind: "user" },
    );
    const coordinatorThreadId = overview.config?.coordinatorThreadId;
    assert.ok(coordinatorThreadId);
    const goalId = ProjectGoalId.makeUnsafe("goal-summary");
    yield* repository.saveGoal(
      {
        id: goalId,
        projectId: groupId,
        objective: "Ship it",
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
    // A worker the coordinator dispatched into the linked repo: the sidebar
    // bucket needs it in memberThreadIds even though its projectId is the repo.
    const linkedWorkerThreadId = ThreadId.makeUnsafe("thread-linked-summary-worker");
    yield* repository.saveTask(
      {
        id: ProjectTaskId.makeUnsafe("task-summary"),
        projectId: groupId,
        goalId,
        title: "Patch repo",
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
    // A worker whose task finished belongs in the Overview's Resolved
    // section — it must not be counted under the group forever.
    const finishedWorkerThreadId = ThreadId.makeUnsafe("thread-linked-finished-worker");
    yield* repository.saveTask(
      {
        id: ProjectTaskId.makeUnsafe("task-summary-done"),
        projectId: groupId,
        goalId,
        title: "Finished patch",
        description: null,
        acceptanceCriteria: null,
        status: "done",
        dependsOnTaskIds: [],
        assignedThreadId: finishedWorkerThreadId,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    // An archived task's worker stays out even while the task reads open.
    const archivedWorkerThreadId = ThreadId.makeUnsafe("thread-linked-archived-worker");
    yield* repository.saveTask(
      {
        id: ProjectTaskId.makeUnsafe("task-summary-archived"),
        projectId: groupId,
        goalId,
        title: "Archived patch",
        description: null,
        acceptanceCriteria: null,
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: archivedWorkerThreadId,
        repairCount: 0,
        archivedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    yield* service.linkProject(
      {
        requestId: "req-summary-link",
        projectId: groupId,
        linkedProjectId: ordinaryId,
      },
      { kind: "user" },
    );
    yield* service.writeDocument(
      {
        requestId: "req-summary-instructions",
        projectId: groupId,
        logicalPath: "instructions.md",
        content: "# Instructions\n\nCheck spelling.\n",
      },
      { kind: "user" },
    );
    const listed = yield* service.listSummaries({}, { kind: "user" });
    const row = listed.summaries.find((summary) => summary.projectId === groupId);
    assert.ok(row);
    assert.equal(row.hasGoal, true);
    assert.equal(row.instructionsConfigured, true);
    assert.deepEqual(row.linkedProjectIds, [ordinaryId]);
    assert.equal(row.memberThreadIds?.includes(coordinatorThreadId), true);
    assert.equal(row.memberThreadIds?.includes(linkedWorkerThreadId), true);
    assert.equal(row.memberThreadIds?.includes(finishedWorkerThreadId), false);
    assert.equal(row.memberThreadIds?.includes(archivedWorkerThreadId), false);
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

it.effect("requireEmpty delete succeeds on a group nothing was added to", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* configureTestGroup(service, "req-empty-setup");
    // Listing initializes the managed library — its seeded Artifacts scaffold
    // must still count as empty.
    yield* service.libraryList({ projectId: groupId }, { kind: "user" });

    const result = yield* service.deleteGroup(
      {
        requestId: "req-empty-del",
        projectId: groupId,
        confirmName: "Alpha",
        requireEmpty: true,
      },
      { kind: "user" },
    );
    assert.equal(result.deletedProjectId, groupId);
    assert.equal(overview.config?.coordinatorThreadId != null, true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("requireEmpty delete refuses once anything landed and leaves the group intact", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* configureTestGroup(service, "req-notempty-setup");
    // A member thread the client-side probe could have missed — the server
    // re-checks under the lock instead of trusting it.
    yield* repository.upsertThreadIndex({
      projectId: groupId,
      threadId: groupMemberThreadId,
      excluded: false,
      archived: false,
      summaryStatus: "covered",
      lastUpdatedAt: now,
      lastSummarizedAt: now,
    });

    const dispatchesBefore = harness.dispatched.length;
    const exit = yield* Effect.exit(
      service.deleteGroup(
        {
          requestId: "req-notempty-del",
          projectId: groupId,
          confirmName: "Alpha",
          requireEmpty: true,
        },
        { kind: "user" },
      ),
    );
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      assert.equal(Option.isSome(failure), true);
      if (Option.isSome(failure)) {
        assert.equal(failure.value.code, "conflict");
        assert.match(failure.value.message, /no longer empty/);
      }
    }

    // Nothing was torn down: no thread or project delete ran, config intact.
    assert.equal(harness.dispatched.length, dispatchesBefore);
    const config = yield* repository.getConfig(groupId);
    assert.equal(Option.isSome(config), true);
    const index = yield* repository.listThreadIndex(groupId);
    assert.equal(
      index.some((entry) => entry.threadId === groupMemberThreadId),
      true,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("skips the digest model call when the digest inputs did not change", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    yield* configureTestGroup(service, "req-digest-skip-setup");

    yield* service.refreshDigest(
      { projectId: groupId, requestId: "req-digest-1" },
      { kind: "user" },
    );
    assert.equal(harness.digestGenerationInputs.length, 1);

    // Same inputs: the refresh short-circuits before any model call.
    yield* service.refreshDigest(
      { projectId: groupId, requestId: "req-digest-2" },
      { kind: "user" },
    );
    assert.equal(harness.digestGenerationInputs.length, 1);

    // Wake bookkeeping is not digest input — a wake-skipped row neither
    // reaches the model prompt nor dirties the input signature.
    yield* repository.appendActivity({
      id: ProjectActivityId.makeUnsafe("pa-skip-1"),
      projectId: groupId,
      kind: "wake-skipped",
      actorKind: "system",
      actorThreadId: null,
      goalId: null,
      taskId: null,
      source: null,
      summary: "wake skipped: coordinator idle",
      createdAt: now,
    });
    yield* service.refreshDigest(
      { projectId: groupId, requestId: "req-digest-3" },
      { kind: "user" },
    );
    assert.equal(harness.digestGenerationInputs.length, 1);

    // A real activity row dirties the signature → the model runs again, and
    // the wake-skipped row is still absent from its activity list.
    yield* repository.appendActivity({
      id: ProjectActivityId.makeUnsafe("pa-skip-2"),
      projectId: groupId,
      kind: "task-created",
      actorKind: "coordinator",
      actorThreadId: null,
      goalId: null,
      taskId: null,
      source: null,
      summary: "Created a task",
      createdAt: now,
    });
    yield* service.refreshDigest(
      { projectId: groupId, requestId: "req-digest-4" },
      { kind: "user" },
    );
    assert.equal(harness.digestGenerationInputs.length, 2);
    const lastInput = harness.digestGenerationInputs.at(-1) as {
      activity?: string;
    };
    assert.equal(lastInput.activity?.includes("wake skipped"), false);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("publishes thread-index-upserted when the coordinator records worker threads", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-idx-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-idx-worker");
    // The stream emits its snapshot only after the live-event subscription is
    // attached — awaiting it removes the publish-vs-subscribe race.
    const snapshotSeen = yield* Deferred.make<void>();
    const collect = yield* service.streamEvents({ projectId: groupId }).pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(snapshotSeen, void 0) : Effect.void,
      ),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(snapshotSeen);

    yield* service.recordManagedWorkerThreads({
      requestId: "req-idx-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Patch the linked repo"],
    });

    const events = yield* Fiber.join(collect);
    const upserted = events.filter((event) => event.type === "thread-index-upserted");
    assert.equal(upserted.length, 1);
    assert.equal(upserted[0]!.projectId, groupId);
    assert.deepEqual(
      upserted[0]!.threads.map((entry) => entry.threadId),
      [workerThreadId],
    );
    const index = yield* repository.listThreadIndex(groupId);
    assert.equal(
      index.some((entry) => entry.threadId === workerThreadId),
      true,
    );
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

it.effect("gives the coordinator thread its playbook packet on every turn", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* configureTestGroup(service, "req-coordinator-packet");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;

    // Called once per dispatchTurnForThread — the coordinator must see its
    // playbook and watch state on every turn, not just the first.
    for (let turn = 0; turn < 2; turn += 1) {
      const packet = yield* service.formatContextPacketForTurn(coordinatorThreadId);
      assert.equal(packet.includes("Group context packet"), true);
      assert.equal(packet.includes("## Playbook\n# Group coordinator playbook"), true);
      assert.equal(packet.includes("## Watch"), true);
      assert.equal(packet.includes("## Workers"), true);
      // The member-only tools section never leaks into the coordinator packet.
      assert.equal(packet.includes("## Group tools"), false);
    }

    // Member threads get the shared packet without the coordinator playbook.
    const memberPacket = yield* service.formatContextPacketForTurn(groupMemberThreadId);
    assert.equal(memberPacket.includes("Group context packet"), true);
    assert.equal(memberPacket.includes("## Playbook"), false);
    assert.equal(memberPacket.includes("## Group tools"), true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("only the coordinator packet claims the welcome message", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-welcome-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;

    const coordinatorPacket = yield* service.formatContextPacketForTurn(coordinatorThreadId);
    assert.equal(
      coordinatorPacket.includes(
        "This thread opened with a welcome message from you; the user may be replying to it.",
      ),
      true,
    );

    // Member threads explain they are not the coordinator instead.
    const memberPacket = yield* service.formatContextPacketForTurn(groupMemberThreadId);
    assert.equal(memberPacket.includes("welcome message from you"), false);
    assert.equal(memberPacket.includes("member thread of this group"), true);

    // Workers resolve through their assigned task. They carry coordinator-like
    // sections, but the welcome line still describes them as member threads.
    const workerThreadId = ThreadId.makeUnsafe("thread-packet-worker");
    yield* repository.saveGoal(
      {
        id: ProjectGoalId.makeUnsafe("goal-packet-worker"),
        projectId: groupId,
        objective: "Fix every flaky test",
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
        id: ProjectTaskId.makeUnsafe("task-packet-worker"),
        projectId: groupId,
        goalId: ProjectGoalId.makeUnsafe("goal-packet-worker"),
        title: "Fix the flaky suite",
        description: null,
        acceptanceCriteria: null,
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: workerThreadId,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    const workerPacket = yield* service.formatContextPacketForTurn(workerThreadId);
    assert.equal(workerPacket.includes("welcome message from you"), false);
    assert.equal(workerPacket.includes("member thread of this group"), true);
    assert.equal(workerPacket.includes("## Playbook"), true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shows the group goal once when the active goal repeats it", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-goal-dedup", {
      goal: "Ship the mobile app",
    });
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;

    const beforeGoal = yield* service.formatContextPacketForTurn(coordinatorThreadId);
    assert.equal(beforeGoal.includes("## Objective\nShip the mobile app"), true);
    // No active goal — the fallback copy still shows under its own label.
    assert.equal(beforeGoal.includes("## Goal\nNone."), true);

    yield* repository.saveGoal(
      {
        id: ProjectGoalId.makeUnsafe("goal-dup"),
        projectId: groupId,
        objective: "Ship the mobile app",
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
    const packet = yield* service.formatContextPacketForTurn(coordinatorThreadId);
    assert.equal(packet.includes("## Objective\nShip the mobile app"), true);
    assert.equal(packet.includes("## Goal"), false);
    assert.equal(packet.split("Ship the mobile app").length - 1, 1);

    // An active goal with different wording keeps its own section.
    yield* repository.saveGoal(
      {
        id: ProjectGoalId.makeUnsafe("goal-dup"),
        projectId: groupId,
        objective: "Ship the mobile app to beta testers",
        authorizationSource: "user",
        scopeVersion: 1,
        acceptanceCriteria: null,
        limits,
        status: "active",
        continuationCount: 0,
        workerCreationCount: 0,
        authorizedAt: now,
        revision: 2,
        createdAt: now,
        updatedAt: now,
      },
      1,
    );
    const updated = yield* service.formatContextPacketForTurn(coordinatorThreadId);
    assert.equal(updated.includes("## Objective\nShip the mobile app"), true);
    assert.equal(updated.includes("## Goal\nShip the mobile app to beta testers"), true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps instructions and the memory index when the packet truncates", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* configureTestGroup(service, "req-trunc-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;

    const instructions = `# Instructions\n\n${"Always run the full check matrix before shipping. ".repeat(280)}`;
    const decisions = `# Decisions\n\n${"Long decision record. ".repeat(2_400)}\nUNIQUE-DECISION-TAIL`;
    const memoryIndex =
      "# Memory\n\n- [preferences](memory/2026-01-01-prefs.md) — user preferences";
    const user = { kind: "user" as const };
    yield* service.writeDocument(
      {
        requestId: "req-trunc-instructions",
        projectId: groupId,
        logicalPath: "instructions.md",
        content: instructions,
      },
      user,
    );
    yield* service.writeDocument(
      {
        requestId: "req-trunc-decisions",
        projectId: groupId,
        logicalPath: "decisions.md",
        content: decisions,
      },
      user,
    );
    yield* service.writeDocument(
      {
        requestId: "req-trunc-memory",
        projectId: groupId,
        logicalPath: MEMORY_AUTO_DOCUMENT_PATH,
        content: memoryIndex,
      },
      user,
    );

    const packet = yield* service.formatContextPacketForTurn(coordinatorThreadId);
    assert.equal(packet.includes("[truncated]"), true);
    // The highest-priority sections survive the budget cut intact.
    assert.equal(packet.includes(instructions), true);
    assert.equal(packet.includes(memoryIndex), true);
    // The oversized Decisions section is what the budget cut, and the trailing
    // task list never made it in.
    assert.equal(packet.includes("## Decisions"), true);
    assert.equal(packet.includes("UNIQUE-DECISION-TAIL"), false);
    assert.equal(packet.includes("## Tasks"), false);
  }).pipe(Effect.provide(harness.layer));
});

// Coordinator-managed worker monitoring: every thread the coordinator
// creates is a tracked worker, so settle/stuck reporting works without an
// active goal.
it.effect("tracks every coordinator-created thread as a managed worker, goal or not", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-mon-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-mon-worker");
    // No active goal: the group was configured without a goal record, so the
    // old code path indexed the thread but never tracked it as a worker.
    yield* service.recordManagedWorkerThreads({
      requestId: "req-mon-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Mars rocket research"],
    });
    const tasks = yield* repository.listTasks({
      projectId: groupId,
      includeArchived: false,
      limit: 10,
    });
    assert.equal(tasks.length, 0);
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker), true);
    if (Option.isSome(worker)) {
      assert.equal(worker.value.projectId, groupId);
      assert.equal(worker.value.batchId, "req-mon-record");
      assert.equal(worker.value.requestId, "req-mon-record");
      assert.equal(worker.value.title, "Mars rocket research");
      assert.equal(worker.value.taskId, null);
      assert.equal(worker.value.settledAt, null);
    }
    const batch = yield* repository.listManagedWorkersByBatch({
      projectId: groupId,
      batchId: "req-mon-record",
    });
    assert.equal(batch.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("posts a settle row into the coordinator thread and wakes it", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-settle-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-settle-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-settle-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Mars rocket research"],
    });
    harness.dispatched.length = 0;
    harness.runNowCalls.length = 0;

    yield* service.ingestSettledThreadEvent({
      threadId: workerThreadId,
      sourceEventId: "settle-worker-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:05:00.000Z",
    });

    const inbox = yield* repository.listInboxAfter({ projectId: groupId, limit: 10 });
    const event = inbox.find((row) => row.sourceEventId === "settle-worker-done");
    assert.equal(event?.eligibleWake, true);
    const rows = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.settled",
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.type === "thread.activity.append" ? row.threadId : null, coordinatorThreadId);
    if (row.type === "thread.activity.append") {
      assert.equal(row.activity.summary, "✓ Mars rocket research finished — no result filed");
    }
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.settleOutcome : null, "completed");
    assert.equal(Option.isSome(worker) ? worker.value.settledAt !== null : false, true);
    // The wake pipeline hands the coordinator a turn through the automation.
    assert.equal(harness.runNowCalls.length >= 1, true);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("posts one roll-up when every worker in the creation batch settles", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-roll-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const threadA = ThreadId.makeUnsafe("thread-roll-a");
    const threadB = ThreadId.makeUnsafe("thread-roll-b");
    const threadC = ThreadId.makeUnsafe("thread-roll-c");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-roll-record",
      batchId: "batch-roll",
      callerThreadId: coordinatorThreadId,
      threadIds: [threadA, threadB, threadC],
      titles: ["Alpha research", "Beta survey", "Gamma page"],
    });
    harness.dispatched.length = 0;
    const rollups = () =>
      harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "synara.workers.settled",
      );

    yield* service.ingestSettledThreadEvent({
      threadId: threadA,
      sourceEventId: "roll-a-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:05:00.000Z",
    });
    yield* service.ingestSettledThreadEvent({
      threadId: threadB,
      sourceEventId: "roll-b-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:06:00.000Z",
    });
    assert.equal(rollups().length, 0);

    yield* service.ingestSettledThreadEvent({
      threadId: threadC,
      sourceEventId: "roll-c-wait",
      // The request-side signal rides the activity-appended kind — the
      // response-requested event fires when the USER answers, not when the
      // worker waits.
      eventType: "approval.requested",
      createdAt: "2026-09-20T00:07:00.000Z",
    });
    // Waiting on approval is not an end state: no roll-up yet.
    assert.equal(rollups().length, 0);

    yield* service.ingestSettledThreadEvent({
      threadId: threadC,
      sourceEventId: "roll-c-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:08:00.000Z",
    });
    assert.equal(rollups().length, 1);
    const rollup = rollups()[0]!;
    if (rollup.type === "thread.activity.append") {
      assert.equal(
        rollup.activity.summary,
        "All 3 threads finished: Alpha research ✓ — no result filed, Beta survey ✓ — no result filed, Gamma page ✓ — no result filed",
      );
      assert.equal(rollup.threadId, coordinatorThreadId);
    }
    // The roll-up also records a wakeable inbox event for reconciliation.
    const inbox = yield* repository.listInboxAfter({ projectId: groupId, limit: 20 });
    const batchEvent = inbox.find((row) => row.eventType === "workers.settled");
    assert.equal(batchEvent?.eligibleWake, true);

    // Re-ingesting the same settle event reposts nothing.
    yield* service.ingestSettledThreadEvent({
      threadId: threadC,
      sourceEventId: "roll-c-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:08:00.000Z",
    });
    assert.equal(rollups().length, 1);
    const settledRows = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.settled",
    );
    // Alpha done, Beta done, Gamma waiting, Gamma done.
    assert.equal(settledRows.length, 4);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("flags quiet and overdue workers once per episode", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-stuck-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const quietThread = ThreadId.makeUnsafe("thread-stuck-quiet");
    const waitingThread = ThreadId.makeUnsafe("thread-stuck-waiting");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-stuck-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [quietThread, waitingThread],
      titles: ["Quiet worker", "Waiting worker"],
    });
    // Running silent past the quiet threshold (TestClock starts at the unix
    // epoch — last activity at epoch goes quiet 10 minutes in).
    harness.threadShells[quietThread] = {
      projectId: groupId,
      title: "Quiet worker",
      session: { status: "running", updatedAt: "1970-01-01T00:00:00.000Z", lastError: null },
      latestTurn: { state: "running", startedAt: "1970-01-01T00:00:00.000Z" },
    };
    // Waiting on an approval since before the waiting threshold. Its turn
    // started (approvals only come from live turns) so the never-started
    // check must not claim it.
    harness.threadShells[waitingThread] = {
      projectId: groupId,
      title: "Waiting worker",
      session: { status: "ready", updatedAt: "1970-01-01T00:00:00.000Z", lastError: null },
      latestTurn: { state: "running", startedAt: "1970-01-01T00:00:00.000Z" },
      hasPendingApprovals: true,
    };
    // The quiet worker's projection says running and the live provider list
    // still carries it — no disconnect, the silence backstop applies.
    harness.providerSessions.push(liveProviderSession(quietThread));
    yield* service.ingestSettledThreadEvent({
      threadId: waitingThread,
      sourceEventId: "stuck-waiting-approval",
      // The request-side signal rides the activity-appended kind — the
      // response-requested event fires when the USER answers, not when the
      // worker waits.
      eventType: "approval.requested",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    harness.dispatched.length = 0;

    const stuckRows = () =>
      harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "synara.worker.stuck",
      );
    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    // The quiet worker reports silent and takes the ladder's first step (an
    // automatic nudge); the waiting worker reports overdue.
    assert.equal(stuckRows().length, 3);
    const summaries = new Set(
      stuckRows().map((row) => (row.type === "thread.activity.append" ? row.activity.summary : "")),
    );
    assert.equal(summaries.has("⚠ Quiet worker has not reported for over 10 minutes"), true);
    assert.equal(
      summaries.has("⚠ Quiet worker was nudged after 10 minutes without progress"),
      true,
    );
    assert.equal(summaries.has("⚠ Waiting worker has been waiting for over 5 minutes"), true);
    const quiet = yield* repository.findManagedWorkerByThread(quietThread);
    assert.equal(Option.isSome(quiet) ? quiet.value.stuckKind : null, "silent");
    const waiting = yield* repository.findManagedWorkerByThread(waitingThread);
    assert.equal(Option.isSome(waiting) ? waiting.value.stuckKind : null, "waiting");

    // Same episode, same dedupe keys: a second pass posts nothing new.
    yield* service.inspectWorkerHealth();
    assert.equal(stuckRows().length, 3);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

it.effect("reports a missing worker shell once", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-missing-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const missingThread = ThreadId.makeUnsafe("thread-missing-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-missing-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [missingThread],
      titles: ["Lost worker"],
    });
    // No thread shell entry: the health check reports the worker missing.
    harness.dispatched.length = 0;
    const missingRows = () =>
      harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "synara.worker.settled" &&
          command.activity.summary === "✗ Lost worker went missing",
      );
    yield* service.inspectWorkerHealth();
    assert.equal(missingRows().length, 1);
    const worker = yield* repository.findManagedWorkerByThread(missingThread);
    assert.equal(Option.isSome(worker) ? worker.value.settleOutcome : null, "missing");
    // The settled missing worker stays quiet while its shell is still gone.
    yield* service.inspectWorkerHealth();
    assert.equal(missingRows().length, 1);
  }).pipe(Effect.provide(harness.layer));
});

// Programmatic stall recovery: the health loop runs the ladder off durable
// worker-row state — it nudges a worker silent past the quiet threshold,
// interrupts + re-dispatches the recorded task prompt after the post-nudge
// delay, then flags it "Waiting on you" once the per-episode cap is hit.
// Every pass re-reads the row, so a mid-episode restart resumes the same step.
const recoveryCommands = (harness: ReturnType<typeof makeTestLayer>) =>
  harness.dispatched.filter((command) => command.commandId.startsWith("agent-recovery:"));

const stuckRowSummaries = (harness: ReturnType<typeof makeTestLayer>) =>
  harness.dispatched
    .filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.stuck",
    )
    .map((command) => (command.type === "thread.activity.append" ? command.activity.summary : ""));

const quietRunningShell = (updatedAt: string) =>
  ({
    projectId: groupId,
    title: "Stalled worker",
    session: {
      status: "running",
      updatedAt,
      lastError: null,
      activeTurnId: "turn-live",
    },
    latestTurn: { state: "running", startedAt: updatedAt },
  }) as const;

// A live provider session matching a projection that says running — keeps the
// dead-session check from claiming workers whose liveness is genuinely fine.
const liveProviderSession = (
  threadId: ThreadId,
  updatedAt = "1970-01-01T00:00:00.000Z",
): ProviderSession =>
  ({
    provider: "codex",
    status: "running",
    runtimeMode: "full-access",
    threadId,
    createdAt: updatedAt,
    updatedAt,
  }) as ProviderSession;

it.effect("nudges a silent worker once per stall episode, then holds", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-nudge-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-nudge-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-nudge-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Stalled worker"],
    });
    // TestClock starts at the unix epoch: last activity at epoch means the
    // quiet threshold is reached 10 minutes in.
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    yield* TestClock.adjust("9 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(recoveryCommands(harness).length, 0);

    yield* TestClock.adjust("2 minutes");
    yield* service.inspectWorkerHealth();
    const nudges = recoveryCommands(harness).filter(
      (command) => command.type === "thread.turn.start",
    );
    assert.equal(nudges.length, 1);
    const nudge = nudges[0]!;
    if (nudge.type === "thread.turn.start") {
      assert.equal(nudge.threadId, workerThreadId);
      assert.equal(nudge.dispatchMode, "steer");
      assert.equal(nudge.dispatchOrigin, "automation");
      assert.equal(
        nudge.message.text,
        "Automatic check from the coordinator: you have produced no output for 10 minutes. Post a one-line status, then continue or report a blocker.",
      );
    }
    assert.equal(
      stuckRowSummaries(harness).includes(
        "⚠ Stalled worker was nudged after 10 minutes without progress",
      ),
      true,
    );
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.recoveryStep : null, 1);
    assert.equal(Option.isSome(worker) ? worker.value.nudgeAt !== null : false, true);

    // Same stall episode: a repeat pass dispatches nothing new.
    yield* service.inspectWorkerHealth();
    assert.equal(recoveryCommands(harness).length, 1);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

it.effect("interrupts and re-dispatches the recorded prompt after the nudge delay", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-redispatch-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-redispatch-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-redispatch-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Stalled worker"],
      prompts: ["Draft the schema migration"],
    });
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(recoveryCommands(harness).length, 1);
    // The persisted step-1 state is all the next pass needs — the same call
    // sequence resumes correctly after a server restart mid-episode.
    const midEpisode = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(midEpisode) ? midEpisode.value.recoveryStep : null, 1);

    yield* TestClock.adjust("4 minutes");
    yield* service.inspectWorkerHealth();
    // Only 4 minutes since the nudge: the redeliver delay has not elapsed.
    assert.equal(recoveryCommands(harness).length, 1);

    yield* TestClock.adjust("2 minutes");
    yield* service.inspectWorkerHealth();
    const commands = recoveryCommands(harness);
    assert.equal(commands.filter((command) => command.type === "thread.turn.interrupt").length, 1);
    const redispatches = commands.filter((command) => command.type === "thread.turn.start");
    assert.equal(redispatches.length, 2);
    const redispatch = redispatches[1]!;
    if (redispatch.type === "thread.turn.start") {
      assert.equal(redispatch.threadId, workerThreadId);
      assert.equal(redispatch.dispatchMode, "queue");
      assert.equal(redispatch.message.text, "Draft the schema migration");
    }
    assert.equal(
      stuckRowSummaries(harness).includes(
        "⚠ Stalled worker was interrupted and had its task re-dispatched",
      ),
      true,
    );
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.recoveryStep : null, 2);
    // Nudge + re-dispatch each count against the cap.
    assert.equal(Option.isSome(worker) ? worker.value.recoveriesUsed : null, 2);

    // Deduped within the episode: a repeat pass dispatches nothing new.
    yield* service.inspectWorkerHealth();
    assert.equal(recoveryCommands(harness).length, 3);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

it.effect("flags the worker Waiting on you once the recovery cap is exhausted", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-cap-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-cap-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-cap-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Stalled worker"],
      prompts: ["Draft the schema migration"],
    });
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    // Recovery 1: nudge at +11m (attempt 1), interrupt + re-dispatch at +17m
    // (attempt 2) — the cap is spent inside the first cycle.
    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    yield* TestClock.adjust("6 minutes");
    yield* service.inspectWorkerHealth();
    const workerAfterFirst = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(workerAfterFirst) ? workerAfterFirst.value.recoveriesUsed : null, 2);

    // The next full quiet window finds the re-dispatch produced nothing —
    // the spent cap latches "Waiting on you" — a Synara-native needs-you row
    // on the coordinator thread (with real actions, not a fake provider
    // request) and one wake for the coordinator to tell the user.
    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    const workerAfterSecond = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(
      Option.isSome(workerAfterSecond) ? workerAfterSecond.value.recoveriesUsed : null,
      2,
    );
    const needsYouRows = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.needs-you",
    );
    assert.equal(needsYouRows.length, 1);
    const needsYouRow = needsYouRows[0]!;
    if (needsYouRow.type === "thread.activity.append") {
      assert.equal(needsYouRow.threadId, coordinatorThreadId);
      assert.equal(
        needsYouRow.activity.summary,
        "✗ Stalled worker needs you — automatic recovery is exhausted",
      );
    }
    // Never a fake provider user-input request — nothing the provider would
    // reject answering.
    const fakeProviderRequests = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "user-input.requested",
    );
    assert.equal(fakeProviderRequests.length, 0);
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.needsYou : null, true);
    const inbox = yield* repository.listInboxAfter({ projectId: groupId, limit: 50 });
    assert.equal(
      inbox.some((row) => row.eventType === "worker.needs-you" && row.eligibleWake),
      true,
    );

    // No further automatic action while the latch holds.
    const dispatchedBefore = harness.dispatched.length;
    yield* service.inspectWorkerHealth();
    assert.equal(harness.dispatched.length, dispatchedBefore);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// Dead-session liveness: the projection still claims "running" but the live
// provider list no longer carries the thread — the worker died silently.
it.effect("settles a running worker whose live session disappeared", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-disc-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-disc-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-disc-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Disconnected worker"],
    });
    harness.threadShells[workerThreadId] = {
      projectId: groupId,
      title: "Disconnected worker",
      session: {
        status: "running",
        updatedAt: "1970-01-01T00:00:00.000Z",
        lastError: null,
        activeTurnId: "turn-live",
      },
      latestTurn: { state: "running", startedAt: "1970-01-01T00:00:00.000Z" },
    };
    // Empty live provider list: no session owns the thread anymore.
    harness.dispatched.length = 0;

    // Inside the 90s grace a freshly spawned session may just not be listed.
    yield* TestClock.adjust("60 seconds");
    yield* service.inspectWorkerHealth();
    assert.equal(harness.dispatched.length, 0);

    yield* TestClock.adjust("60 seconds");
    yield* service.inspectWorkerHealth();
    const settled = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.settled",
    );
    assert.equal(settled.length, 1);
    const settleRow = settled[0]!;
    if (settleRow.type === "thread.activity.append") {
      assert.equal(settleRow.activity.summary, "\u2717 Disconnected worker lost its session");
    }
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.settleOutcome : null, "failed");

    // Deduped: a second pass posts nothing.
    yield* service.inspectWorkerHealth();
    assert.equal(settled.length, 1);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// Never-started: the coordinator created the thread but no session or first
// turn landed inside the 3-minute grace — one counted re-dispatch, then
// "Waiting on you" under the shared recovery cap.
it.effect("re-dispatches a worker that never starts once, then waits on you", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-never-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-never-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-never-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Unstarted worker"],
      prompts: ["Survey the Mars data"],
    });
    // Shell exists but carries no session and no started turn.
    harness.threadShells[workerThreadId] = {
      projectId: groupId,
      title: "Unstarted worker",
      session: null,
    };
    harness.dispatched.length = 0;

    // Inside the grace window the worker may still be spawning.
    yield* TestClock.adjust("2 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(harness.dispatched.length, 0);

    yield* TestClock.adjust("2 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(
      stuckRowSummaries(harness).includes(
        "\u26a0 Unstarted worker never started — no session or turn within 3 minutes",
      ),
      true,
    );
    const firstRedispatches = recoveryCommands(harness).filter(
      (command) => command.type === "thread.turn.start",
    );
    assert.equal(firstRedispatches.length, 1);
    const redispatch = firstRedispatches[0]!;
    if (redispatch.type === "thread.turn.start") {
      assert.equal(redispatch.dispatchMode, "queue");
      assert.equal(redispatch.message.text, "Survey the Mars data");
    }
    const afterFirst = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(afterFirst) ? afterFirst.value.recoveriesUsed : null, 1);

    // The re-dispatch produced no session either — second counted attempt.
    yield* TestClock.adjust("6 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(recoveryCommands(harness).length, 2);

    // Cap spent (WORKER_RECOVERY_MAX_ATTEMPTS): "Waiting on you" latches and
    // no further automatic dispatches fire.
    yield* TestClock.adjust("6 minutes");
    yield* service.inspectWorkerHealth();
    const latched = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(latched) ? latched.value.needsYou : null, true);
    assert.equal(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "synara.worker.needs-you",
      ),
      true,
    );
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// synara_project_report_result drives the settle row and the roll-up instead
// of generic text; a finished worker without one gets "no result filed".
it.effect("quotes report_result in the settle row and roll-up", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-result-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const threadA = ThreadId.makeUnsafe("thread-result-a");
    const threadB = ThreadId.makeUnsafe("thread-result-b");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-result-record",
      batchId: "batch-result",
      callerThreadId: coordinatorThreadId,
      threadIds: [threadA, threadB],
      titles: ["Alpha work", "Beta work"],
    });
    harness.threadShells[threadA] = {
      projectId: groupId,
      title: "Alpha work",
      session: { status: "ready", updatedAt: now, lastError: null },
    };
    harness.threadShells[threadB] = {
      projectId: groupId,
      title: "Beta work",
      session: { status: "ready", updatedAt: now, lastError: null },
    };
    yield* repository.saveGoal(
      {
        id: ProjectGoalId.makeUnsafe("goal-result"),
        projectId: groupId,
        objective: "Ship the migration",
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
    const task = yield* repository.saveTask(
      {
        id: ProjectTaskId.makeUnsafe("task-result-a"),
        projectId: groupId,
        goalId: ProjectGoalId.makeUnsafe("goal-result"),
        title: "Alpha work",
        description: null,
        acceptanceCriteria: null,
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: threadA,
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      null,
    );
    yield* service.reportResult(
      {
        requestId: "req-result-1",
        projectId: groupId,
        taskId: task.id,
        summary: "Shipped the migration — 12 files changed",
      },
      { kind: "worker", threadId: threadA, projectId: groupId, taskId: task.id },
    );
    harness.dispatched.length = 0;

    yield* service.ingestSettledThreadEvent({
      threadId: threadA,
      sourceEventId: "result-a-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:05:00.000Z",
    });
    yield* service.ingestSettledThreadEvent({
      threadId: threadB,
      sourceEventId: "result-b-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:06:00.000Z",
    });

    const settledRows = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.settled",
    );
    assert.equal(settledRows.length, 2);
    const summaryOf = (row: OrchestrationCommand) =>
      row.type === "thread.activity.append" ? row.activity.summary : "";
    // The structured result replaces the generic "finished" phrase.
    assert.equal(
      summaryOf(settledRows[0]!),
      "\u2713 Alpha work Shipped the migration — 12 files changed",
    );
    // No result filed: the gap is noted inline so nobody opens the thread.
    assert.equal(summaryOf(settledRows[1]!), "\u2713 Beta work finished — no result filed");
    const rollups = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.workers.settled",
    );
    assert.equal(rollups.length, 1);
    if (rollups[0]!.type === "thread.activity.append") {
      assert.equal(
        rollups[0]!.activity.summary,
        "All 2 threads finished: Alpha work: Shipped the migration — 12 files changed, Beta work \u2713 — no result filed",
      );
    }
  }).pipe(Effect.provide(harness.layer));
});

// The finished settle row and the roll-up carry the thread's tracked PR link
// when the server knows one.
it.effect("adds the tracked PR link to finished rows and the roll-up", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const overview = yield* configureTestGroup(service, "req-pr-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const threadA = ThreadId.makeUnsafe("thread-pr-a");
    const threadB = ThreadId.makeUnsafe("thread-pr-b");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-pr-record",
      batchId: "batch-pr",
      callerThreadId: coordinatorThreadId,
      threadIds: [threadA, threadB],
      titles: ["Linked work", "Plain work"],
    });
    harness.threadShells[threadA] = {
      projectId: groupId,
      title: "Linked work",
      session: { status: "ready", updatedAt: now, lastError: null },
      lastKnownPr: {
        url: "https://github.com/diliprt/synara/pull/42",
        state: "open",
        isDraft: false,
      },
    };
    harness.threadShells[threadB] = {
      projectId: groupId,
      title: "Plain work",
      session: { status: "ready", updatedAt: now, lastError: null },
    };
    harness.dispatched.length = 0;

    yield* service.ingestSettledThreadEvent({
      threadId: threadA,
      sourceEventId: "pr-a-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:05:00.000Z",
    });
    yield* service.ingestSettledThreadEvent({
      threadId: threadB,
      sourceEventId: "pr-b-done",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:06:00.000Z",
    });

    const settledRows = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.settled",
    );
    const summaryOf = (row: OrchestrationCommand) =>
      row.type === "thread.activity.append" ? row.activity.summary : "";
    assert.equal(
      summaryOf(settledRows[0]!),
      "\u2713 Linked work finished — no result filed — https://github.com/diliprt/synara/pull/42",
    );
    assert.equal(summaryOf(settledRows[1]!), "\u2713 Plain work finished — no result filed");
    const rollups = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.workers.settled",
    );
    assert.equal(rollups.length, 1);
    if (rollups[0]!.type === "thread.activity.append") {
      assert.equal(
        rollups[0]!.activity.summary,
        "All 2 threads finished: Linked work \u2713 — no result filed — https://github.com/diliprt/synara/pull/42, Plain work \u2713 — no result filed",
      );
    }
  }).pipe(Effect.provide(harness.layer));
});

// Silence is measured from the durable last-runtime-activity stamp, not the
// session lifecycle updatedAt — a busy worker streaming output stays quiet-
// safe even though its session row never moved.
it.effect("measures silence from last runtime activity, not the lifecycle stamp", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-lastact-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-lastact-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-lastact-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Busy worker"],
    });
    // Lifecycle stamp is frozen at epoch, but the worker produced runtime
    // output 9 minutes in — a 12-minute test suite must not get nudged.
    harness.threadShells[workerThreadId] = {
      projectId: groupId,
      title: "Busy worker",
      session: {
        status: "running",
        updatedAt: "1970-01-01T00:00:00.000Z",
        lastError: null,
        activeTurnId: "turn-live",
        lastActivityAt: "1970-01-01T00:09:00.000Z",
      },
      latestTurn: { state: "running", startedAt: "1970-01-01T00:00:00.000Z" },
    };
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    // Only 2 minutes of real quiet — updatedAt alone would have flagged it.
    assert.equal(harness.dispatched.length, 0);
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.stuckKind : "x", null);

    // Real quiet: another 9 minutes without runtime activity tips it over.
    yield* TestClock.adjust("9 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(
      stuckRowSummaries(harness).includes(
        "\u26a0 Busy worker has not reported for over 10 minutes",
      ),
      true,
    );
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// A running tool call is runtime activity: the ladder never nudges or
// interrupts while one is in flight — only a >45-minute tool gets a nudge +
// notify, never an interrupt.
it.effect("never interrupts a tool call in flight, only nudges past the hard cap", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-tool-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-tool-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-tool-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Tool worker"],
      prompts: ["Run the suite"],
    });
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.toolInFlightByThread[workerThreadId] = [
      { itemId: "tool-item-1", turnId: "turn-live", startedAt: "1970-01-01T00:00:00.000Z" },
    ];
    harness.dispatched.length = 0;

    // Past the silence threshold with a tool mid-flight: no nudge, no row.
    yield* TestClock.adjust("12 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(recoveryCommands(harness).length, 0);
    assert.equal(stuckRowSummaries(harness).length, 0);

    // Past the 45-minute hard cap: one nudge + notify, never an interrupt.
    yield* TestClock.adjust("40 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(
      stuckRowSummaries(harness).includes(
        "\u26a0 Tool worker has a tool call running for over 45 minutes",
      ),
      true,
    );
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.stuckKind : null, "tool-overtime");
    const commands = recoveryCommands(harness);
    const nudges = commands.filter(
      (command) => command.type === "thread.turn.start" && command.dispatchMode === "steer",
    );
    assert.equal(nudges.length, 1);
    assert.equal(commands.filter((command) => command.type === "thread.turn.interrupt").length, 0);
    assert.equal(
      commands.filter(
        (command) => command.type === "thread.turn.start" && command.dispatchMode === "queue",
      ).length,
      0,
    );

    // Deduped per in-flight tool: no second nudge for the same call.
    yield* service.inspectWorkerHealth();
    assert.equal(recoveryCommands(harness).length, 1);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// The lifetime recovery count survives across distinct episodes — the real
// sequence is activity moving between stalls (the re-dispatch's own turn
// updates lastActivityAt), not a frozen timestamp.
it.effect("keeps the recovery count across episodes and caps the chain", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-episode-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-episode-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-episode-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Stalled worker"],
      prompts: ["Draft the schema migration"],
    });
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    // `stallAt` models the projected session: activity that also produced
    // real work stamps `lastProgressAt`; a bare echo leaves it unset.
    const stallAt = (iso: string, progressIso?: string) => {
      harness.threadShells[workerThreadId] = {
        projectId: groupId,
        title: "Stalled worker",
        session: {
          status: "running",
          updatedAt: iso,
          lastError: null,
          activeTurnId: "turn-live",
          lastActivityAt: iso,
          ...(progressIso === undefined ? {} : { lastProgressAt: progressIso }),
        },
        latestTurn: { state: "running", startedAt: iso },
      };
    };
    stallAt("1970-01-01T00:00:00.000Z");
    harness.dispatched.length = 0;

    // Episode 1: nudge at +11m (attempt 1), interrupt + re-dispatch at +17m
    // (attempt 2).
    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    yield* TestClock.adjust("6 minutes");
    yield* service.inspectWorkerHealth();
    const afterFirst = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(afterFirst) ? afterFirst.value.recoveriesUsed : null, 2);

    // The re-dispatch produced real output: work landed at t=18m, so the
    // quiet pass clears the episode — but the lifetime count stays.
    stallAt("1970-01-01T00:18:00.000Z", "1970-01-01T00:18:00.000Z");
    yield* service.inspectWorkerHealth();
    const healthy = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(healthy) ? healthy.value.recoveriesUsed : null, 2);
    assert.equal(Option.isSome(healthy) ? healthy.value.stuckKind : "x", null);
    // Ladder steps post rows only — they never wake the coordinator model.
    assert.equal(harness.runNowCalls.length, 0);

    // Episode 2 at t=29m+: the spent cap latches "Waiting on you" instead of
    // cycling another recovery.
    yield* TestClock.adjust("12 minutes");
    yield* service.inspectWorkerHealth();
    yield* TestClock.adjust("6 minutes");
    yield* service.inspectWorkerHealth();
    const afterSecond = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(afterSecond) ? afterSecond.value.recoveriesUsed : null, 2);
    assert.equal(Option.isSome(afterSecond) ? afterSecond.value.needsYou : null, true);

    // Activity + another stall while the latch holds: nothing else fires.
    stallAt("1970-01-01T00:35:00.000Z", "1970-01-01T00:35:00.000Z");
    yield* TestClock.adjust("12 minutes");
    yield* service.inspectWorkerHealth();
    const latched = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(latched) ? latched.value.needsYou : null, true);
    assert.equal(harness.runNowCalls.length >= 1, true);
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// Turn ownership: a turn the user started is never nudged, interrupted, or
// re-prompted; the next coordinator turn re-arms monitoring.
it.effect("leaves user-owned turns alone and re-arms on coordinator turns", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-owner-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-owner-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-owner-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Owned worker"],
      prompts: ["Draft the schema migration"],
    });
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    // The user took over the thread — dispatchOrigin "user" marks ownership.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: "cmd-user-takeover",
      dispatchOrigin: "user",
      turnId: "turn-user-1",
      createdAt: "1970-01-01T00:01:00.000Z",
    });
    yield* TestClock.adjust("15 minutes");
    yield* service.inspectWorkerHealth();
    // Silent for 15 minutes but the active turn is the user's: no ladder.
    assert.equal(recoveryCommands(harness).length, 0);
    assert.equal(stuckRowSummaries(harness).length, 0);
    const owned = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(owned) ? owned.value.activeTurnOrigin : null, "user");

    // A new coordinator-originated turn re-arms the ladder.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: "cmd-coordinator-followup",
      dispatchOrigin: "automation",
      turnId: "turn-coord-2",
      createdAt: "1970-01-01T00:16:00.000Z",
    });
    yield* TestClock.adjust("1 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(
      recoveryCommands(harness).filter((command) => command.type === "thread.turn.start").length >=
        1,
      true,
    );
    const rearmed = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(rearmed) ? rearmed.value.activeTurnOrigin : null, "coordinator");
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// Re-arm: after a terminal settle, a new coordinator/ladder turn re-opens
// monitoring — the next stall reports again.
it.effect("re-arms monitoring after settle when a new turn starts", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-rearm-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-rearm-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-rearm-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Rearmed worker"],
      prompts: ["Draft the schema migration"],
    });
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));

    yield* service.ingestSettledThreadEvent({
      threadId: workerThreadId,
      sourceEventId: "rearm-settle",
      eventType: "thread.turn-diff-completed",
      createdAt: "1970-01-01T00:02:00.000Z",
    });
    const settledWorker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(
      Option.isSome(settledWorker) ? settledWorker.value.settleOutcome : null,
      "completed",
    );

    // A follow-up coordinator turn clears the settle and ownership marks the
    // turn as coordinator's — the quiet ladder applies again.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: "cmd-coordinator-rearm",
      dispatchOrigin: "automation",
      turnId: "turn-rearm",
      createdAt: "1970-01-01T00:03:00.000Z",
    });
    const rearmed = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(rearmed) ? rearmed.value.settledAt : "x", null);
    assert.equal(Option.isSome(rearmed) ? rearmed.value.settleOutcome : "x", null);

    harness.dispatched.length = 0;
    yield* TestClock.adjust("12 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(
      stuckRowSummaries(harness).includes(
        "\u26a0 Rearmed worker has not reported for over 10 minutes",
      ),
      true,
    );
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// Paused groups: state still records but no coordinator rows post.
it.effect("suppresses monitor rows while the group is paused", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-pause-mon-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-pause-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-pause-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Paused worker"],
    });
    yield* service.pauseGroup({ requestId: "req-pause", projectId: groupId }, { kind: "user" });
    harness.dispatched.length = 0;

    yield* service.ingestSettledThreadEvent({
      threadId: workerThreadId,
      sourceEventId: "pause-settle",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:05:00.000Z",
    });

    // The worker's row still recorded the settle — only the rows suppress.
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.settleOutcome : null, "completed");
    const monitorRows = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        String(command.activity.kind).startsWith("synara.worker"),
    );
    assert.equal(monitorRows.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

// Response-side events: `*-response-requested` fires when the USER answers —
// it must not mark the worker waiting or post rows.
it.effect("ignores user-answer events for waiting detection", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-resp-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-resp-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-resp-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Answering worker"],
    });
    harness.dispatched.length = 0;

    yield* service.ingestSettledThreadEvent({
      threadId: workerThreadId,
      sourceEventId: "resp-answered",
      eventType: "thread.approval-response-requested",
      createdAt: "2026-09-20T00:05:00.000Z",
    });

    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.settledAt : "x", null);
    assert.equal(Option.isSome(worker) ? worker.value.waitingSince : "x", null);
    assert.equal(harness.dispatched.length, 0);
    const inbox = yield* repository.listInboxAfter({ projectId: groupId, limit: 10 });
    const event = inbox.find((row) => row.sourceEventId === "resp-answered");
    assert.equal(event?.eligibleWake, false);
  }).pipe(Effect.provide(harness.layer));
});

// Compare-and-set: a monitor write built on a stale row loses, it doesn't
// revert a concurrent settle.
it.effect("rejects a monitor write built on a stale worker row", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-cas-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-cas-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-cas-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["CAS worker"],
    });
    const stale = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(stale), true);
    if (Option.isNone(stale)) return;

    yield* service.ingestSettledThreadEvent({
      threadId: workerThreadId,
      sourceEventId: "cas-settle",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:05:00.000Z",
    });

    // A write carrying the pre-settle updatedAt must not land — the settle
    // would be reverted by a stale-read upsert.
    const result = yield* repository.saveManagedWorkerMonitor({
      worker: { ...stale.value, needsYou: true },
      expectedUpdatedAt: stale.value.updatedAt,
    });
    assert.equal(result.applied, false);
    const fresh = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(fresh) ? fresh.value.settleOutcome : null, "completed");
    assert.equal(Option.isSome(fresh) ? fresh.value.needsYou : null, false);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("logs coordinator check-ins to the activity log without waking it", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-checkin-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    harness.runNowCalls.length = 0;

    harness.threadDetails[coordinatorThreadId] = {
      messages: [
        {
          id: "msg-checkin-user",
          role: "user",
          text: "[automation] Hourly heartbeat",
          turnId: "turn-checkin-1",
          dispatchOrigin: "automation",
        },
        {
          id: "msg-checkin-assistant",
          role: "assistant",
          text: "SILENT",
          turnId: "turn-checkin-1",
        },
      ],
    };
    yield* service.ingestSettledThreadEvent({
      threadId: coordinatorThreadId,
      sourceEventId: "checkin-silent-1",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T00:10:00.000Z",
      turnId: "turn-checkin-1",
    });

    harness.threadDetails[coordinatorThreadId] = {
      messages: [
        {
          id: "msg-checkin-user-2",
          role: "user",
          text: "[automation] Hourly heartbeat",
          turnId: "turn-checkin-2",
          dispatchOrigin: "automation",
        },
        {
          id: "msg-checkin-assistant-2",
          role: "assistant",
          text: "Beta survey failed — needs a look.",
          turnId: "turn-checkin-2",
        },
      ],
    };
    yield* service.ingestSettledThreadEvent({
      threadId: coordinatorThreadId,
      sourceEventId: "checkin-report-1",
      eventType: "thread.turn-diff-completed",
      createdAt: "2026-09-20T01:10:00.000Z",
      turnId: "turn-checkin-2",
    });

    const activity = yield* repository.listActivity({ projectId: groupId, limit: 40 });
    const checkinRows = activity.filter((row) => row.kind === "coordinator-checkin");
    assert.equal(checkinRows.length, 2);
    assert.equal(checkinRows[1]?.summary, "Coordinator check-in: nothing to report.");
    assert.equal(
      checkinRows[0]?.summary,
      "Coordinator check-in: Beta survey failed — needs a look.",
    );
    // Check-in turns never wake the coordinator.
    assert.equal(harness.runNowCalls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

// A turn-diff that closed missing/error belongs to a turn the ladder
// interrupted — it settles `interrupted`, never `completed`: the recovery
// count survives and no false "finished" row posts. A `ready` diff still
// settles completed and refunds the count (a genuine success).
it.effect("settles a missing diff as interrupted without resetting the recovery count", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-missing-diff-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-missing-diff-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-missing-diff-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Stalled worker"],
      prompts: ["Draft the schema migration"],
    });
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    // Drive the ladder to step 2: nudge at +11m, interrupt + re-dispatch at
    // +17m — the cap is spent inside the first cycle.
    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    yield* TestClock.adjust("6 minutes");
    yield* service.inspectWorkerHealth();
    const mid = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(mid) ? mid.value.recoveriesUsed : null, 2);

    // The ladder's own interrupt closes the checkpoint `missing`: the
    // diff-completed event must not read as a clean finish.
    yield* service.ingestSettledThreadEvent({
      threadId: workerThreadId,
      sourceEventId: "diff-missing-1",
      eventType: "thread.turn-diff-completed",
      checkpointStatus: "missing",
      createdAt: "1970-01-01T00:18:00.000Z",
    });
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.settleOutcome : null, "interrupted");
    // The ladder's own interrupt never refunds the attempts it spent.
    assert.equal(Option.isSome(worker) ? worker.value.recoveriesUsed : null, 2);
    const settled = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.settled",
    );
    assert.equal(settled.length, 1);
    if (settled[0]!.type === "thread.activity.append") {
      assert.equal(settled[0]!.activity.summary, "⚠ Stalled worker was interrupted");
    }

    // A re-armed worker whose next turn genuinely finishes still settles
    // completed — and refunds the recovery count.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: "coordinator:follow-up",
      dispatchOrigin: null,
      turnId: "turn-follow-up",
      eventType: "thread.turn-start-requested",
      createdAt: "1970-01-01T00:19:00.000Z",
    });
    yield* service.ingestSettledThreadEvent({
      threadId: workerThreadId,
      sourceEventId: "diff-ready-1",
      eventType: "thread.turn-diff-completed",
      checkpointStatus: "ready",
      createdAt: "1970-01-01T00:25:00.000Z",
    });
    const finished = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(finished) ? finished.value.settleOutcome : null, "completed");
    assert.equal(Option.isSome(finished) ? finished.value.recoveriesUsed : null, 0);
    const settledRows = harness.dispatched.filter(
      (command) =>
        command.type === "thread.activity.append" &&
        command.activity.kind === "synara.worker.settled",
    );
    assert.equal(settledRows.length, 2);
    if (settledRows[1]!.type === "thread.activity.append") {
      assert.equal(settledRows[1]!.activity.summary, "✓ Stalled worker finished — no result filed");
    }
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// A provider that only echoes the recovery steer emits activity without real
// progress: the ladder re-anchors the quiet window but keeps its position —
// it never clears and never restarts. Two counted attempts later the spent
// cap latches "Waiting on you" instead of re-nudging every 10 minutes.
it.effect("escalates through a nudge echo instead of clearing the ladder", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-echo-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-echo-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-echo-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Stalled worker"],
      prompts: ["Draft the schema migration"],
    });
    const shellAt = (iso: string) => {
      // Activity moves (the provider echoed the steer) but nothing produced
      // work — `lastProgressAt` stays unset.
      harness.threadShells[workerThreadId] = {
        projectId: groupId,
        title: "Stalled worker",
        session: {
          status: "running",
          updatedAt: iso,
          lastError: null,
          activeTurnId: "turn-live",
          lastActivityAt: iso,
        },
        latestTurn: { state: "running", startedAt: iso },
      };
    };
    shellAt("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    // Nudge at +11m (attempt 1).
    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    assert.equal(
      recoveryCommands(harness).filter((command) => command.type === "thread.turn.start").length,
      1,
    );

    // The provider echoes the steer back — activity moves, no real work.
    shellAt("1970-01-01T00:11:30.000Z");
    yield* TestClock.adjust("6 minutes");
    yield* service.inspectWorkerHealth();
    // The echo did NOT clear the ladder — and it must not re-nudge either.
    assert.equal(
      recoveryCommands(harness).filter((command) => command.type === "thread.turn.start").length,
      1,
    );
    const afterEcho = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(afterEcho) ? afterEcho.value.recoveryStep : null, 1);

    // Once the quiet window elapses past the echo stamp, the SAME chain
    // resumes: interrupt + re-dispatch (attempt 2).
    yield* TestClock.adjust("5 minutes");
    yield* service.inspectWorkerHealth();
    const stepTwo = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(stepTwo) ? stepTwo.value.recoveriesUsed : null, 2);
    assert.equal(
      recoveryCommands(harness).filter((command) => command.type === "thread.turn.interrupt")
        .length,
      1,
    );

    // Another echo with no work, another quiet window — the spent cap
    // latches "Waiting on you" instead of re-nudging forever.
    shellAt("1970-01-01T00:23:00.000Z");
    yield* TestClock.adjust("12 minutes");
    yield* service.inspectWorkerHealth();
    const latched = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(latched) ? latched.value.needsYou : null, true);
    // Total automatic dispatches: one nudge steer + one interrupt + one
    // re-dispatch. No silent infinite loop.
    const starts = recoveryCommands(harness).filter(
      (command) => command.type === "thread.turn.start",
    );
    assert.equal(starts.length, 2);
    assert.equal(
      recoveryCommands(harness).filter((command) => command.type === "thread.turn.interrupt")
        .length,
      1,
    );
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// The ladder claims its step on the durable row BEFORE the dispatch: the
// async ownership write that the dispatch triggers (`recordWorkerTurnRequest`
// on the turn-start-requested event) must not drop the claimed step or the
// recovery count.
it.effect("keeps the claimed ladder step when the ownership write lands after it", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-claim-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-claim-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-claim-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Stalled worker"],
      prompts: ["Draft the schema migration"],
    });
    harness.threadShells[workerThreadId] = quietRunningShell("1970-01-01T00:00:00.000Z");
    harness.providerSessions.push(liveProviderSession(workerThreadId));
    harness.dispatched.length = 0;

    yield* TestClock.adjust("11 minutes");
    yield* service.inspectWorkerHealth();
    const claimed = yield* repository.findManagedWorkerByThread(workerThreadId);
    // The claim is durable already — before the nudge's own turn-request
    // event could possibly land.
    assert.equal(Option.isSome(claimed) ? claimed.value.recoveryStep : null, 1);
    assert.equal(Option.isSome(claimed) ? claimed.value.recoveriesUsed : null, 1);
    const nudge = recoveryCommands(harness)[0]!;

    // The steer lands and the engine reports the new turn — the ownership
    // rewrite must keep the claimed ladder state.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: nudge.commandId,
      dispatchOrigin: "automation",
      turnId: "turn-nudge-1",
      eventType: "thread.turn-start-requested",
      createdAt: now,
    });
    const worker = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(worker) ? worker.value.recoveryStep : null, 1);
    assert.equal(Option.isSome(worker) ? worker.value.recoveriesUsed : null, 1);
    assert.equal(Option.isSome(worker) ? worker.value.activeTurnOrigin : null, "ladder");
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});

// A coordinator message that queues behind a running USER turn must not
// flip the running turn's ownership — the promotion's turn-start-requested
// event is where ownership changes hands.
it.effect("keeps user-turn ownership while a coordinator turn is only queued", () => {
  const harness = makeTestLayer();
  return Effect.gen(function* () {
    const service = yield* ProjectAgentService;
    const repository = yield* ProjectAgentRepository;
    const overview = yield* configureTestGroup(service, "req-queued-setup");
    const coordinatorThreadId = overview.config!.coordinatorThreadId!;
    const workerThreadId = ThreadId.makeUnsafe("thread-queued-worker");
    yield* service.recordManagedWorkerThreads({
      requestId: "req-queued-record",
      callerThreadId: coordinatorThreadId,
      threadIds: [workerThreadId],
      titles: ["Busy worker"],
    });

    // The user started a turn — ownership is theirs.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: "user:turn-1",
      dispatchOrigin: "user",
      turnId: "turn-user-1",
      eventType: "thread.turn-start-requested",
      createdAt: now,
    });
    // A coordinator message lands while the user's turn still runs — it
    // queues. Ownership must stay with the running user turn.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: "coordinator:msg-1",
      dispatchOrigin: null,
      turnId: null,
      eventType: "thread.turn-queued",
      createdAt: now,
    });
    const queued = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(queued) ? queued.value.activeTurnOrigin : null, "user");
    assert.equal(Option.isSome(queued) ? queued.value.activeTurnCommandId : null, "user:turn-1");

    // The queued coordinator turn is promoted — NOW ownership moves.
    yield* service.recordWorkerTurnRequest({
      threadId: workerThreadId,
      commandId: "server:dispatch-queued-turn:7",
      dispatchOrigin: null,
      turnId: "turn-coord-1",
      eventType: "thread.turn-start-requested",
      createdAt: now,
    });
    const promoted = yield* repository.findManagedWorkerByThread(workerThreadId);
    assert.equal(Option.isSome(promoted) ? promoted.value.activeTurnOrigin : null, "coordinator");
  }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
});
