import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type AutomationCreateInput,
  type GitCreateWorktreeInput,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { OrchestrationCommandInternalError } from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepositoryLive } from "../../persistence/Layers/AutomationRepository.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { AutomationService } from "../Services/AutomationService.ts";
import { AutomationServiceLive } from "./AutomationService.ts";

const now = "2026-06-16T10:00:00.000Z";
const projectId = ProjectId.makeUnsafe("automation-project");
const project: OrchestrationProjectShell = {
  id: projectId,
  kind: "project",
  title: "Automation Project",
  workspaceRoot: "/tmp/automation-project",
  defaultModelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  },
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
};

const dispatchedCommands: OrchestrationCommand[] = [];
const createdWorktrees: GitCreateWorktreeInput[] = [];
let gitMode: "nonRepo" | "worktree" = "nonRepo";
let gitStatusHook: ((cwd: string) => Effect.Effect<void>) | null = null;
// Configurable thread shell returned by the ProjectionSnapshotQuery mock; reconcile
// tests set it to drive the run's latest-turn outcome.
let threadShell: Option.Option<OrchestrationThreadShell> = Option.none();
// When set, the orchestration dispatch mock fails on the matching command type so we
// can exercise the failed-run / advance-after-dispatch paths.
let failDispatchType: OrchestrationCommand["type"] | null = null;
let dispatchHook:
  | ((command: OrchestrationCommand) => Effect.Effect<void, OrchestrationCommandInternalError>)
  | null = null;

function resetHarness() {
  dispatchedCommands.length = 0;
  createdWorktrees.length = 0;
  gitMode = "nonRepo";
  gitStatusHook = null;
  threadShell = Option.none();
  failDispatchType = null;
  dispatchHook = null;
}

// Build a partial thread shell; only the fields reconcileThread reads are populated.
function makeThreadShell(overrides: {
  readonly id?: ThreadId;
  readonly projectId?: ProjectId;
  readonly latestTurn?: OrchestrationThreadShell["latestTurn"];
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly lastError?: string | null;
}): OrchestrationThreadShell {
  return {
    id: overrides.id ?? ThreadId.makeUnsafe("thread-shell"),
    projectId: overrides.projectId ?? projectId,
    latestTurn: overrides.latestTurn ?? null,
    hasPendingApprovals: overrides.hasPendingApprovals,
    hasPendingUserInput: overrides.hasPendingUserInput,
    session: overrides.lastError !== undefined ? { lastError: overrides.lastError } : null,
  } as unknown as OrchestrationThreadShell;
}

function makeLatestTurn(
  state: "running" | "completed" | "error" | "interrupted",
  turnId: TurnId = TurnId.makeUnsafe("turn-reconcile"),
): OrchestrationThreadShell["latestTurn"] {
  return {
    turnId,
    state,
    requestedAt: now,
    startedAt: now,
    completedAt: state === "completed" ? now : null,
    assistantMessageId: null,
  } as unknown as OrchestrationThreadShell["latestTurn"];
}

const createInput = (
  worktreeMode: AutomationCreateInput["worktreeMode"] = "local",
): AutomationCreateInput => ({
  name: "Nightly maintenance",
  projectId,
  prompt: "Check stale dependencies.",
  schedule: { type: "manual" },
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  },
  worktreeMode,
  acknowledgedRisks: worktreeMode === "local" ? ["local-checkout"] : [],
});

const orchestrationEngine = {
  readEvents: () => Stream.empty,
  getReadModel: () =>
    Effect.succeed({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: now,
    }),
  dispatch: (command: OrchestrationCommand) =>
    failDispatchType !== null && command.type === failDispatchType
      ? Effect.fail(
          new OrchestrationCommandInternalError({
            commandId: command.commandId,
            commandType: command.type,
            detail: "dispatch rejected by test harness",
          }),
        )
      : Effect.gen(function* () {
          if (dispatchHook) {
            yield* dispatchHook(command);
          }
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
  repairState: () =>
    Effect.succeed({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: now,
    }),
  streamDomainEvents: Stream.empty,
} satisfies OrchestrationEngineShape;

const projectionSnapshotQuery = {
  getCommandReadModel: () =>
    Effect.succeed({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: now,
    }),
  getSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: now,
    }),
  getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 0 }),
  getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
  getShellSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 0,
      projects: [project],
      threads: [],
      updatedAt: now,
    }),
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.some(project as never)),
  getProjectShellById: () => Effect.succeed(Option.some(project)),
  getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  getFullThreadDiffContext: () => Effect.succeed(Option.none()),
  getThreadShellById: () => Effect.succeed(threadShell),
  findSyntheticSubagentParentThread: () => Effect.succeed(Option.none()),
  getThreadDetailById: () => Effect.succeed(Option.none()),
  getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
} as unknown as ProjectionSnapshotQueryShape;

const gitCore = {
  statusDetails: (cwd: string) =>
    Effect.gen(function* () {
      if (gitStatusHook) {
        yield* gitStatusHook(cwd);
      }
      return {
        isRepo: gitMode === "worktree",
        hasOriginRemote: false,
        isDefaultBranch: true,
        branch: gitMode === "worktree" ? "main" : null,
        upstreamRef: null,
        upstreamBranch: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        cwd,
      };
    }),
  createWorktree: (input: GitCreateWorktreeInput) =>
    Effect.sync(() => {
      createdWorktrees.push(input);
      return {
        worktree: {
          path: "/tmp/automation-worktree",
          branch: input.newBranch ?? input.branch,
        },
      };
    }),
} as unknown as GitCoreShape;

const layer = it.layer(
  AutomationServiceLive.pipe(
    Layer.provideMerge(AutomationRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
    Layer.provideMerge(Layer.succeed(GitCore, gitCore)),
  ),
);

layer("AutomationService", (it) => {
  it.effect("creates and lists automation definitions", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput());
      const listed = yield* service.list({ projectId });

      assert.strictEqual(created.runtimeMode, "approval-required");
      assert.strictEqual(listed.definitions.length, 1);
      assert.strictEqual(listed.definitions[0]?.id, created.id);
    }),
  );

  it.effect("initializes future scheduled automations with their first real run time", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const runAt = "2099-01-01T00:00:00.000Z";

      const created = yield* service.create({
        ...createInput("local"),
        schedule: { type: "once", runAt },
      });
      const results = yield* service.runDueOnce({
        now: "2030-01-01T00:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(created.nextRunAt, runAt);
      assert.strictEqual(results.length, 0);
      assert.strictEqual(dispatchedCommands.length, 0);
    }),
  );

  it.effect("runs a manual automation through normal thread commands", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const created = yield* service.create(createInput("local"));

      const result = yield* service.runNow({ automationId: created.id });
      const threadCreate = dispatchedCommands[0];
      const turnStart = dispatchedCommands[1];

      assert.strictEqual(result.run.status, "running");
      assert.strictEqual(dispatchedCommands.length, 2);
      assert.strictEqual(threadCreate?.type, "thread.create");
      assert.strictEqual(turnStart?.type, "thread.turn.start");
      if (threadCreate?.type !== "thread.create" || turnStart?.type !== "thread.turn.start") {
        assert.fail("Expected thread.create and thread.turn.start commands.");
      }
      assert.strictEqual(threadCreate.envMode, "local");
      assert.strictEqual(threadCreate.runtimeMode, "approval-required");
      assert.strictEqual(turnStart.message.text, "Check stale dependencies.");
      assert.strictEqual(turnStart.dispatchMode, "queue");
      assert.strictEqual(result.run.threadId, threadCreate.threadId);
      assert.strictEqual(result.run.messageId, turnStart.message.messageId);
      assert.strictEqual(result.run.threadCreateCommandId, threadCreate.commandId);
      assert.strictEqual(result.run.turnStartCommandId, turnStart.commandId);
    }),
  );

  it.effect("creates a named worktree for worktree-mode automations", () =>
    Effect.gen(function* () {
      resetHarness();
      gitMode = "worktree";
      const service = yield* AutomationService;
      const created = yield* service.create(createInput("worktree"));

      yield* service.runNow({ automationId: created.id });
      const threadCreate = dispatchedCommands[0];

      assert.strictEqual(createdWorktrees.length, 1);
      assert.match(createdWorktrees[0]?.newBranch ?? "", /^automation\/nightly-maintenance\//);
      assert.strictEqual(threadCreate?.type, "thread.create");
      if (threadCreate?.type !== "thread.create") {
        assert.fail("Expected thread.create command.");
      }
      assert.strictEqual(threadCreate.envMode, "worktree");
      assert.strictEqual(threadCreate.worktreePath, "/tmp/automation-worktree");
      assert.strictEqual(threadCreate.associatedWorktreeBranch, createdWorktrees[0]?.newBranch);
    }),
  );

  it.effect("does not dispatch a run cancelled while resolving the environment", () =>
    Effect.gen(function* () {
      resetHarness();
      gitMode = "worktree";
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-cancel-before-dispatch");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("worktree"),
          schedule: { type: "interval", everySeconds: 300 },
          stopOnError: true,
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      gitStatusHook = () =>
        Effect.gen(function* () {
          const runs = yield* repository
            .listActiveRunsForDefinition({ automationId })
            .pipe(Effect.orDie);
          const run = runs.find((entry) => entry.automationId === automationId);
          if (run) {
            yield* repository
              .cancelRun({
                runId: run.id,
                now: "2026-06-16T10:00:30.000Z",
              })
              .pipe(Effect.orDie);
          }
        });

      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(
        results.find((entry) => entry.run.automationId === automationId)?.run.status,
        "cancelled",
      );
      assert.strictEqual(
        dispatchedCommands.some(
          (command) => command.type === "thread.create" || command.type === "thread.turn.start",
        ),
        false,
      );
      assert.strictEqual(createdWorktrees.length, 0);
      const reloaded = yield* service.list({ projectId });
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.enabled, true);
    }),
  );

  it.effect("rejects auto local checkout fallback without acknowledgement", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("auto"));
      const error = yield* service.runNow({ automationId: created.id }).pipe(Effect.flip);

      assert.match(error.message, /local checkout fallback/);
      assert.strictEqual(
        dispatchedCommands.filter((command) => command.type === "thread.create").length,
        0,
      );
    }),
  );

  it.effect("allows acknowledged auto local checkout fallback", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create({
        ...createInput("auto"),
        acknowledgedRisks: ["local-checkout"],
      });
      yield* service.runNow({ automationId: created.id });

      const threadCreate = dispatchedCommands.find((command) => command.type === "thread.create");
      assert.strictEqual(threadCreate?.type, "thread.create");
      if (threadCreate?.type !== "thread.create") {
        assert.fail("Expected thread.create command.");
      }
      assert.strictEqual(threadCreate.envMode, "local");
    }),
  );

  it.effect("runs due scheduled automations once and advances the next run", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-due-service");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });
      const listed = yield* service.list({ projectId });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]?.run.trigger.type, "scheduled");
      assert.strictEqual(results[0]?.run.scheduledFor, "2026-06-16T10:00:00.000Z");
      assert.strictEqual(dispatchedCommands.length, 2);
      assert.strictEqual(
        listed.definitions.find((definition) => definition.id === automationId)?.nextRunAt,
        "2026-06-16T10:05:00.000Z",
      );
    }),
  );

  it.effect("records and advances missed scheduled occurrences when misfire policy is skip", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-misfire-skip");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          misfirePolicy: "skip",
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:11:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(
        results.filter((entry) => entry.run.automationId === automationId).length,
        0,
      );
      const listed = yield* service.list({ projectId });
      const definition = listed.definitions.find((entry) => entry.id === automationId);
      const runs = listed.runs.filter((entry) => entry.automationId === automationId);
      assert.strictEqual(definition?.nextRunAt, "2026-06-16T10:15:00.000Z");
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, "skipped");
      yield* repository.disableDefinition({ id: automationId, now: "2026-06-16T10:11:00.000Z" });
    }),
  );

  it.effect("runs the current slot for missed schedules when misfire policy is run-latest", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-misfire-latest");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          misfirePolicy: "run-latest",
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:11:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      const runForAutomation = results.find((entry) => entry.run.automationId === automationId);
      assert.strictEqual(runForAutomation?.run.scheduledFor, "2026-06-16T10:11:00.000Z");
      const listed = yield* service.list({ projectId });
      const definition = listed.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.nextRunAt, "2026-06-16T10:16:00.000Z");
      yield* repository.disableDefinition({ id: automationId, now: "2026-06-16T10:11:00.000Z" });
    }),
  );

  it.effect("runs one-shot automations once and disables them", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-once-service");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "once", runAt: "2026-06-16T10:00:15.000Z" },
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      const first = yield* service.runDueOnce({
        now: "2026-06-16T10:00:15.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });
      const second = yield* service.runDueOnce({
        now: "2026-06-16T10:00:20.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });
      const listed = yield* service.list({ projectId });

      assert.strictEqual(first.length, 1);
      assert.strictEqual(second.length, 0);
      const definition = listed.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.enabled, false);
      assert.strictEqual(definition?.nextRunAt, null);
      assert.strictEqual(
        listed.runs.filter((entry) => entry.automationId === automationId).length,
        1,
      );
    }),
  );

  it.effect("reconciles a completed turn into a succeeded run", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId;
      assert.isNotNull(threadId);

      threadShell = Option.some(makeThreadShell({ latestTurn: makeLatestTurn("completed") }));
      yield* service.reconcileThread({ threadId: threadId! });

      const reloaded = yield* service.list({ projectId });
      const reconciled = reloaded.runs.find((entry) => entry.id === run.id);
      assert.strictEqual(reconciled?.status, "succeeded");
      assert.strictEqual(reconciled?.turnId, TurnId.makeUnsafe("turn-reconcile"));
    }),
  );

  it.effect("reconciles an error turn into a failed run with the session error", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId!;

      threadShell = Option.some(
        makeThreadShell({
          latestTurn: makeLatestTurn("error"),
          lastError: "provider exploded",
        }),
      );
      yield* service.reconcileThread({ threadId });

      const reloaded = yield* service.list({ projectId });
      const reconciled = reloaded.runs.find((entry) => entry.id === run.id);
      assert.strictEqual(reconciled?.status, "failed");
      assert.strictEqual(reconciled?.error, "provider exploded");
    }),
  );

  it.effect("clamps long failed-run summaries to the result schema limit", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId!;
      const longError = "x".repeat(3_000);

      threadShell = Option.some(
        makeThreadShell({
          latestTurn: makeLatestTurn("error"),
          lastError: longError,
        }),
      );
      yield* service.reconcileThread({ threadId });

      const reloaded = yield* service.list({ projectId });
      const reconciled = reloaded.runs.find((entry) => entry.id === run.id);
      assert.strictEqual(reconciled?.status, "failed");
      assert.strictEqual(reconciled?.result?.summary?.length, 2_000);
    }),
  );

  it.effect("reconciles an interrupted turn into an interrupted run", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId!;

      threadShell = Option.some(makeThreadShell({ latestTurn: makeLatestTurn("interrupted") }));
      yield* service.reconcileThread({ threadId });

      const reloaded = yield* service.list({ projectId });
      assert.strictEqual(reloaded.runs.find((entry) => entry.id === run.id)?.status, "interrupted");
    }),
  );

  it.effect("reconciles pending approvals into waiting-for-approval", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId!;

      threadShell = Option.some(
        makeThreadShell({
          latestTurn: makeLatestTurn("running"),
          hasPendingApprovals: true,
        }),
      );
      yield* service.reconcileThread({ threadId });

      const reloaded = yield* service.list({ projectId });
      assert.strictEqual(
        reloaded.runs.find((entry) => entry.id === run.id)?.status,
        "waiting-for-approval",
      );
    }),
  );

  it.effect("reconciles a cleared approval wait back into running", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId!;

      threadShell = Option.some(
        makeThreadShell({
          latestTurn: makeLatestTurn("running"),
          hasPendingApprovals: true,
        }),
      );
      yield* service.reconcileThread({ threadId });

      threadShell = Option.some(makeThreadShell({ latestTurn: makeLatestTurn("running") }));
      yield* service.reconcileThread({ threadId });

      const reloaded = yield* service.list({ projectId });
      const reconciled = reloaded.runs.find((entry) => entry.id === run.id);
      assert.strictEqual(reconciled?.status, "running");
      assert.strictEqual(reconciled?.result, null);
    }),
  );

  it.effect("leaves a still-running turn untouched on reconcile", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId!;
      assert.strictEqual(run.status, "running");

      threadShell = Option.some(makeThreadShell({ latestTurn: makeLatestTurn("running") }));
      yield* service.reconcileThread({ threadId });

      const reloaded = yield* service.list({ projectId });
      assert.strictEqual(reloaded.runs.find((entry) => entry.id === run.id)?.status, "running");
    }),
  );

  it.effect("times out active runs that exceed maxRuntimeSeconds", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-timeout");
      const threadId = ThreadId.makeUnsafe("thread-timeout");
      const messageId = MessageId.makeUnsafe("message-timeout");
      const threadCreateCommandId = CommandId.makeUnsafe("command-timeout-thread");
      const turnStartCommandId = CommandId.makeUnsafe("command-timeout-turn");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          maxRuntimeSeconds: 1,
          stopOnError: false,
        },
        now: "2000-01-01T00:00:00.000Z",
      });
      const run = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-timeout"),
        automationId,
        projectId,
        threadId,
        messageId,
        threadCreateCommandId,
        turnStartCommandId,
        trigger: { type: "manual" },
        scheduledFor: "2000-01-01T00:00:00.000Z",
        permissionSnapshot: {
          provider: "codex",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreeMode: "local",
          allowedCapabilities: ["send-turn"],
          createdAt: "2000-01-01T00:00:00.000Z",
        },
        now: "2000-01-01T00:00:00.000Z",
      });
      yield* repository.markRunStarted({
        id: run.id,
        threadId,
        messageId,
        threadCreateCommandId,
        turnStartCommandId,
        startedAt: "2000-01-01T00:00:00.000Z",
      });

      yield* service.reconcileActiveRuns();

      const listed = yield* service.list({ projectId });
      const timedOut = listed.runs.find((entry) => entry.id === run.id);
      assert.strictEqual(timedOut?.status, "failed");
      assert.match(timedOut?.error ?? "", /runtime limit/);
      assert.isDefined(
        dispatchedCommands.find(
          (command) => command.type === "thread.turn.interrupt" && command.threadId === threadId,
        ),
      );
    }),
  );

  it.effect("does not overwrite a succeeded result when a timeout loses the race", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-timeout-race");
      const runId = AutomationRunId.makeUnsafe("run-timeout-race");
      const threadId = ThreadId.makeUnsafe("thread-timeout-race");
      const messageId = MessageId.makeUnsafe("message-timeout-race");
      const threadCreateCommandId = CommandId.makeUnsafe("command-timeout-race-thread");
      const turnStartCommandId = CommandId.makeUnsafe("command-timeout-race-turn");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          maxRuntimeSeconds: 1,
          stopOnError: false,
        },
        now: "2000-01-01T00:00:00.000Z",
      });
      const run = yield* repository.createRun({
        id: runId,
        automationId,
        projectId,
        threadId,
        messageId,
        threadCreateCommandId,
        turnStartCommandId,
        trigger: { type: "manual" },
        scheduledFor: "2000-01-01T00:00:00.000Z",
        permissionSnapshot: {
          provider: "codex",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreeMode: "local",
          allowedCapabilities: ["send-turn"],
          createdAt: "2000-01-01T00:00:00.000Z",
        },
        now: "2000-01-01T00:00:00.000Z",
      });
      yield* repository.markRunStarted({
        id: run.id,
        threadId,
        messageId,
        threadCreateCommandId,
        turnStartCommandId,
        startedAt: "2000-01-01T00:00:00.000Z",
      });
      dispatchHook = (command) =>
        command.type === "thread.turn.interrupt"
          ? repository
              .markRunSucceeded({
                id: run.id,
                turnId: TurnId.makeUnsafe("turn-timeout-race-completed"),
                result: {
                  outcome: "no-findings",
                  summary: "Completed before timeout.",
                  unread: false,
                  archivedAt: null,
                },
                finishedAt: "2026-06-16T10:00:00.000Z",
              })
              .pipe(Effect.asVoid, Effect.orDie)
          : Effect.void;

      yield* service.reconcileActiveRuns();

      const listed = yield* service.list({ projectId });
      const reconciled = listed.runs.find((entry) => entry.id === run.id);
      assert.strictEqual(reconciled?.status, "succeeded");
      assert.strictEqual(reconciled?.result?.outcome, "no-findings");
      assert.strictEqual(reconciled?.result?.summary, "Completed before timeout.");
    }),
  );

  it.effect("runs a heartbeat automation by continuing the target thread", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const targetThreadId = ThreadId.makeUnsafe("heartbeat-target-thread");
      threadShell = Option.some(makeThreadShell({ id: targetThreadId }));

      const created = yield* service.create({
        ...createInput("local"),
        mode: "heartbeat",
        targetThreadId,
      });

      const { run } = yield* service.runNow({ automationId: created.id });

      // Heartbeat continues an existing thread: exactly one turn start, no thread create.
      assert.strictEqual(dispatchedCommands.length, 1);
      const command = dispatchedCommands[0];
      assert.strictEqual(command?.type, "thread.turn.start");
      if (command?.type !== "thread.turn.start") {
        assert.fail("Expected a thread.turn.start command.");
      }
      assert.strictEqual(command.threadId, targetThreadId);
      assert.isUndefined(dispatchedCommands.find((entry) => entry.type === "thread.create"));
      assert.strictEqual(run.threadId, targetThreadId);
      assert.strictEqual(run.status, "running");
    }),
  );

  it.effect("does not complete a queued heartbeat run from an unrelated latest turn", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const projectionTurns = yield* ProjectionTurnRepository;
      const targetThreadId = ThreadId.makeUnsafe("heartbeat-queued-thread");
      const unrelatedTurnId = TurnId.makeUnsafe("turn-unrelated");
      const automationTurnId = TurnId.makeUnsafe("turn-automation");
      threadShell = Option.some(makeThreadShell({ id: targetThreadId }));

      const created = yield* service.create({
        ...createInput("local"),
        mode: "heartbeat",
        targetThreadId,
      });
      const { run } = yield* service.runNow({ automationId: created.id });
      assert.isNotNull(run.messageId);

      threadShell = Option.some(
        makeThreadShell({
          id: targetThreadId,
          latestTurn: makeLatestTurn("completed", unrelatedTurnId),
        }),
      );
      yield* service.reconcileThread({ threadId: targetThreadId });

      const queued = yield* service.list({ projectId });
      assert.strictEqual(queued.runs.find((entry) => entry.id === run.id)?.status, "running");

      yield* projectionTurns.upsertByTurnId({
        threadId: targetThreadId,
        turnId: automationTurnId,
        pendingMessageId: run.messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      threadShell = Option.some(
        makeThreadShell({
          id: targetThreadId,
          latestTurn: makeLatestTurn("completed", automationTurnId),
        }),
      );
      yield* service.reconcileThread({ threadId: targetThreadId });

      const reconciled = yield* service.list({ projectId });
      const updated = reconciled.runs.find((entry) => entry.id === run.id);
      assert.strictEqual(updated?.status, "succeeded");
      assert.strictEqual(updated?.turnId, automationTurnId);
    }),
  );

  it.effect("rejects creating a heartbeat automation without a target thread", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const exit = yield* service
        .create({ ...createInput("local"), mode: "heartbeat" })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("rejects a heartbeat target from a different project", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const targetThreadId = ThreadId.makeUnsafe("heartbeat-foreign-thread");
      threadShell = Option.some(
        makeThreadShell({
          id: targetThreadId,
          projectId: ProjectId.makeUnsafe("other-project"),
        }),
      );

      const exit = yield* service
        .create({ ...createInput("local"), mode: "heartbeat", targetThreadId })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("rejects moving a heartbeat automation away from its target thread project", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const targetThreadId = ThreadId.makeUnsafe("heartbeat-move-thread");
      threadShell = Option.some(makeThreadShell({ id: targetThreadId }));

      const created = yield* service.create({
        ...createInput("local"),
        mode: "heartbeat",
        targetThreadId,
      });
      const exit = yield* service
        .update({ id: created.id, projectId: ProjectId.makeUnsafe("other-project") })
        .pipe(Effect.exit);

      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("rejects updating an automation into heartbeat without a target thread", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const created = yield* service.create(createInput("local"));

      const exit = yield* service.update({ id: created.id, mode: "heartbeat" }).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("clears heartbeat max iterations when switching back to standalone", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const targetThreadId = ThreadId.makeUnsafe("heartbeat-to-standalone-thread");
      threadShell = Option.some(makeThreadShell({ id: targetThreadId }));

      const created = yield* service.create({
        ...createInput("local"),
        mode: "heartbeat",
        targetThreadId,
        maxIterations: 3,
      });
      const updated = yield* service.update({
        id: created.id,
        mode: "standalone",
        targetThreadId: null,
      });

      assert.strictEqual(updated.mode, "standalone");
      assert.strictEqual(updated.maxIterations, null);
    }),
  );

  it.effect("rejects custom schedules faster than the configured minimum interval", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const error = yield* service
        .create({
          ...createInput("local"),
          schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
          minimumIntervalSeconds: 120,
        })
        .pipe(Effect.flip);

      assert.match(error.message, /120 seconds apart/);
    }),
  );

  it.effect("allows acknowledged fast recurring intervals at the default minimum", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create({
        ...createInput("local"),
        schedule: { type: "interval", everySeconds: 15 },
        acknowledgedRisks: ["fast-interval", "local-checkout"],
      });

      assert.strictEqual(created.schedule.type, "interval");
      assert.deepStrictEqual(created.acknowledgedRisks, ["fast-interval", "local-checkout"]);
    }),
  );

  it.effect("rejects unacknowledged fast recurring intervals", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const error = yield* service
        .create({
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 15 },
        })
        .pipe(Effect.flip);

      assert.match(error.message, /60 seconds apart/);
    }),
  );

  it.effect("rejects unacknowledged full-access automations", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const error = yield* service
        .create({
          ...createInput("worktree"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.match(error.message, /full-access/);
    }),
  );

  it.effect("rejects unacknowledged local-checkout automations", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const error = yield* service
        .create({
          ...createInput("local"),
          acknowledgedRisks: [],
        })
        .pipe(Effect.flip);

      assert.match(error.message, /local checkout/);
    }),
  );

  it.effect("rejects updates that switch to local checkout without acknowledgement", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const created = yield* service.create(createInput("worktree"));

      const error = yield* service
        .update({
          id: created.id,
          worktreeMode: "local",
        })
        .pipe(Effect.flip);

      assert.match(error.message, /local checkout/);
    }),
  );

  it.effect("rejects enabled one-shot schedules that no longer have a future run", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const error = yield* service
        .create({
          ...createInput("local"),
          schedule: { type: "once", runAt: "2000-01-01T00:00:00.000Z" },
        })
        .pipe(Effect.flip);

      assert.match(error.message, /future run time/);
    }),
  );

  it.effect("rejects retry policies until retry attempts are modeled", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const error = yield* service
        .create({
          ...createInput("local"),
          retryPolicy: { type: "fixed", maxAttempts: 3, delaySeconds: 30 },
        })
        .pipe(Effect.flip);

      assert.match(error.message, /retry policies are not supported/);
    }),
  );

  it.effect("disables a scheduled automation that has reached its iteration cap", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-max-iters");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          maxIterations: 1,
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      // Push iterationCount up to the cap so the next due run must stop.
      yield* repository.incrementDefinitionIterationCount({
        id: automationId,
        now: "2026-06-16T10:00:00.000Z",
      });

      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(results.length, 0);
      assert.strictEqual(dispatchedCommands.length, 0);
      const reloaded = yield* service.list({ projectId });
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.enabled, false);
      // No run row was created for the capped occurrence.
      assert.strictEqual(
        reloaded.runs.filter((entry) => entry.automationId === automationId).length,
        0,
      );
    }),
  );

  it.effect("disables a stopOnError automation when its run reconciles to failed", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-stop-on-error");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          stopOnError: true,
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });
      const run = results[0]?.run;
      assert.isDefined(run);
      const threadId = run!.threadId!;

      threadShell = Option.some(
        makeThreadShell({
          latestTurn: makeLatestTurn("error"),
          lastError: "loop failure",
        }),
      );
      yield* service.reconcileThread({ threadId });

      const reloaded = yield* service.list({ projectId });
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.enabled, false);
      assert.strictEqual(reloaded.runs.find((entry) => entry.id === run!.id)?.status, "failed");
    }),
  );

  it.effect("skips a due heartbeat run while the target thread is in flight", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-in-flight");
      const targetThreadId = ThreadId.makeUnsafe("thread-in-flight-target");
      threadShell = Option.some(makeThreadShell({ id: targetThreadId }));

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          mode: "heartbeat",
          targetThreadId,
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      // First due tick creates + dispatches a run that stays running (no reconcile).
      const first = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });
      const firstForAutomation = first.filter((entry) => entry.run.automationId === automationId);
      assert.strictEqual(firstForAutomation.length, 1);
      const activeRun = firstForAutomation[0]!.run;
      const targetThreadDispatchCount = () =>
        dispatchedCommands.filter(
          (command) => command.type === "thread.turn.start" && command.threadId === targetThreadId,
        ).length;
      const dispatchedBefore = targetThreadDispatchCount();
      assert.strictEqual(dispatchedBefore, 1);
      assert.strictEqual(
        yield* repository.countActiveRunsForThread({ threadId: targetThreadId }),
        1,
      );

      // Second due tick: the prior run is still active, so no new run is dispatched,
      // but the schedule still advances past this occurrence.
      const second = yield* service.runDueOnce({
        now: "2026-06-16T10:05:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(
        second.filter((entry) => entry.run.automationId === automationId).length,
        0,
      );
      assert.strictEqual(targetThreadDispatchCount(), dispatchedBefore);
      const reloaded = yield* service.list({ projectId });
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.nextRunAt, "2026-06-16T10:10:00.000Z");
      const runs = reloaded.runs.filter((entry) => entry.automationId === automationId);
      assert.strictEqual(runs.length, 2);
      assert.strictEqual(runs[0]?.status, "skipped");

      const projectionTurns = yield* ProjectionTurnRepository;
      yield* projectionTurns.upsertByTurnId({
        threadId: targetThreadId,
        turnId: TurnId.makeUnsafe("turn-in-flight-complete"),
        pendingMessageId: activeRun.messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      threadShell = Option.some(
        makeThreadShell({
          id: targetThreadId,
          latestTurn: makeLatestTurn("completed", TurnId.makeUnsafe("turn-in-flight-complete")),
        }),
      );
      yield* service.reconcileThread({ threadId: targetThreadId });

      const reconciled = yield* service.list({ projectId });
      assert.strictEqual(
        reconciled.runs.find((entry) => entry.id === activeRun.id)?.status,
        "succeeded",
      );
      assert.strictEqual(
        yield* repository.countActiveRunsForThread({ threadId: targetThreadId }),
        0,
      );
    }),
  );

  it.effect("records a failed run and still advances the schedule when dispatch fails", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-dispatch-fail");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          // No stopOnError so the failure does not also disable the automation here.
          stopOnError: false,
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      failDispatchType = "thread.create";
      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      // The run was created durably and surfaces as failed despite dispatch blowing up.
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]?.run.status, "failed");

      const reloaded = yield* service.list({ projectId });
      const runs = reloaded.runs.filter((entry) => entry.automationId === automationId);
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0]?.status, "failed");
      // The occurrence is not silently lost: the schedule advanced to the next slot.
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.nextRunAt, "2026-06-16T10:05:00.000Z");
    }),
  );

  it.effect("persists standalone thread ids before turn dispatch starts", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-turn-start-fail");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          stopOnError: false,
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      failDispatchType = "thread.turn.start";
      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(dispatchedCommands[0]?.type, "thread.create");
      assert.strictEqual(results[0]?.run.status, "failed");

      const reloaded = yield* service.list({ projectId });
      const failedRun = reloaded.runs.find((entry) => entry.automationId === automationId);
      assert.strictEqual(failedRun?.status, "failed");
      assert.isNotNull(failedRun?.threadId ?? null);
    }),
  );

  it.effect("recovers standalone pending rows using their persisted thread id", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-standalone-recovery");
      const threadId = ThreadId.makeUnsafe("thread-standalone-recovery");
      const messageId = MessageId.makeUnsafe("message-standalone-recovery");
      const turnId = TurnId.makeUnsafe("turn-standalone-recovery");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          stopOnError: false,
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-standalone-recovery"),
        automationId,
        projectId,
        threadId,
        messageId,
        threadCreateCommandId: CommandId.makeUnsafe("command-standalone-recovery-thread"),
        turnStartCommandId: CommandId.makeUnsafe("command-standalone-recovery-turn"),
        trigger: { type: "scheduled" },
        scheduledFor: "2026-06-16T10:00:00.000Z",
        permissionSnapshot: {
          provider: "codex",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreeMode: "local",
          allowedCapabilities: ["send-turn"],
          createdAt: "2026-06-16T10:00:00.000Z",
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      threadShell = Option.some(
        makeThreadShell({
          id: threadId,
          latestTurn: makeLatestTurn("completed", turnId),
        }),
      );

      yield* service.recoverPendingRuns();

      const reloaded = yield* service.list({ projectId });
      const recovered = reloaded.runs.find((entry) => entry.automationId === automationId);
      assert.strictEqual(recovered?.status, "succeeded");
      assert.strictEqual(recovered?.threadId, threadId);
    }),
  );

  it.effect("interrupts heartbeat recovery rows whose turn was never queued", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-heartbeat-no-turn");
      const targetThreadId = ThreadId.makeUnsafe("thread-heartbeat-no-turn");

      threadShell = Option.some(makeThreadShell({ id: targetThreadId }));
      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          mode: "heartbeat",
          targetThreadId,
          schedule: { type: "interval", everySeconds: 300 },
          stopOnError: false,
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-heartbeat-no-turn"),
        automationId,
        projectId,
        threadId: targetThreadId,
        messageId: MessageId.makeUnsafe("message-heartbeat-no-turn"),
        threadCreateCommandId: null,
        turnStartCommandId: CommandId.makeUnsafe("command-heartbeat-no-turn"),
        trigger: { type: "scheduled" },
        scheduledFor: "2026-06-16T10:00:00.000Z",
        permissionSnapshot: {
          provider: "codex",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreeMode: "local",
          allowedCapabilities: ["send-turn"],
          createdAt: "2026-06-16T10:00:00.000Z",
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* service.recoverPendingRuns();

      const reloaded = yield* service.list({ projectId });
      const interrupted = reloaded.runs.find((entry) => entry.automationId === automationId);
      assert.strictEqual(interrupted?.status, "interrupted");
      assert.strictEqual(
        yield* repository.countActiveRunsForThread({ threadId: targetThreadId }),
        0,
      );
    }),
  );

  it.effect("disables a stopOnError automation when dispatch fails", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-dispatch-fail-stop");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          stopOnError: true,
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      failDispatchType = "thread.create";
      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(
        results.find((entry) => entry.run.automationId === automationId)?.run.status,
        "failed",
      );
      const reloaded = yield* service.list({ projectId });
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.enabled, false);
    }),
  );

  it.effect("does not disable stopOnError when cancellation wins a dispatch failure race", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-cancel-wins-dispatch-fail");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
          stopOnError: true,
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      dispatchHook = (command) =>
        command.type === "thread.turn.start"
          ? Effect.gen(function* () {
              const runOption = yield* repository
                .getRunByThreadId({ threadId: command.threadId })
                .pipe(Effect.orDie);
              const run = Option.getOrThrow(runOption);
              yield* repository
                .cancelRun({
                  runId: run.id,
                  now: "2026-06-16T10:00:30.000Z",
                })
                .pipe(Effect.orDie);
              return yield* Effect.fail(
                new OrchestrationCommandInternalError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "dispatch cancelled by test harness",
                }),
              );
            })
          : Effect.void;

      const results = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(
        results.find((entry) => entry.run.automationId === automationId)?.run.status,
        "cancelled",
      );
      const reloaded = yield* service.list({ projectId });
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      const run = reloaded.runs.find((entry) => entry.automationId === automationId);
      assert.strictEqual(definition?.enabled, true);
      assert.strictEqual(run?.status, "cancelled");
    }),
  );

  it.effect(
    "does not re-dispatch or double-count an occurrence whose run was interrupted before the schedule advanced",
    () =>
      Effect.gen(function* () {
        resetHarness();
        const service = yield* AutomationService;
        const repository = yield* AutomationRepository;
        const automationId = AutomationId.makeUnsafe("automation-crash-replay");
        const scheduledFor = "2026-06-16T10:00:00.000Z";

        yield* repository.createDefinition({
          id: automationId,
          input: {
            ...createInput("local"),
            schedule: { type: "interval", everySeconds: 300 },
          },
          now: scheduledFor,
        });

        // Simulate a prior process that created the scheduled run, then crashed before it
        // advanced the schedule or counted the iteration. Recovery marked the orphaned run
        // interrupted; nextRunAt and iterationCount were never updated.
        const crashed = yield* repository.createRun({
          id: AutomationRunId.makeUnsafe("run-crashed"),
          automationId,
          projectId,
          threadId: null,
          trigger: { type: "scheduled" },
          scheduledFor,
          permissionSnapshot: {
            provider: "codex",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            worktreeMode: "local",
            allowedCapabilities: ["send-turn"],
            createdAt: scheduledFor,
          },
          now: scheduledFor,
        });
        yield* repository.markRunInterrupted({
          id: crashed.id,
          turnId: null,
          finishedAt: scheduledFor,
        });

        const results = yield* service.runDueOnce({
          now: scheduledFor,
          limit: 10,
          leaseOwnerId: "test-scheduler",
        });

        // The already-recorded occurrence is not re-dispatched (no orphan thread)...
        assert.strictEqual(results.length, 0);
        assert.strictEqual(dispatchedCommands.length, 0);
        const reloaded = yield* service.list({ projectId });
        const definition = reloaded.definitions.find((entry) => entry.id === automationId);
        // ...but the schedule still advances past it...
        assert.strictEqual(definition?.nextRunAt, "2026-06-16T10:05:00.000Z");
        // ...and the iteration count is not double-incremented for the deduped occurrence.
        assert.strictEqual(definition?.iterationCount, 0);
        assert.strictEqual(
          reloaded.runs.filter((entry) => entry.automationId === automationId).length,
          1,
        );
        assert.strictEqual(
          reloaded.runs.find((entry) => entry.id === crashed.id)?.status,
          "interrupted",
        );
      }),
  );

  it.effect(
    "cancels an active run by dispatching an interrupt and keeping cancelled terminal",
    () =>
      Effect.gen(function* () {
        resetHarness();
        const service = yield* AutomationService;

        const created = yield* service.create(createInput("local"));
        const { run } = yield* service.runNow({ automationId: created.id });
        const threadId = run.threadId!;

        const cancelled = yield* service.cancelRun({ runId: run.id });
        assert.strictEqual(cancelled.run.status, "cancelled");
        assert.isDefined(
          dispatchedCommands.find(
            (command) => command.type === "thread.turn.interrupt" && command.threadId === threadId,
          ),
        );

        threadShell = Option.some(makeThreadShell({ latestTurn: makeLatestTurn("completed") }));
        yield* service.reconcileThread({ threadId });

        const reloaded = yield* service.list({ projectId });
        assert.strictEqual(reloaded.runs.find((entry) => entry.id === run.id)?.status, "cancelled");
      }),
  );

  it.effect("deleting an automation cancels and interrupts its active runs", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;

      const created = yield* service.create(createInput("local"));
      const { run } = yield* service.runNow({ automationId: created.id });
      const threadId = run.threadId!;

      yield* service.delete({ id: created.id });

      const reloaded = yield* service.list({ projectId, includeArchived: true });
      const definition = reloaded.definitions.find((entry) => entry.id === created.id);
      assert.isNotNull(definition?.archivedAt ?? null);
      assert.strictEqual(reloaded.runs.find((entry) => entry.id === run.id)?.status, "cancelled");
      assert.isDefined(
        dispatchedCommands.find(
          (command) => command.type === "thread.turn.interrupt" && command.threadId === threadId,
        ),
      );
    }),
  );

  it.effect("refuses a manual heartbeat run while a prior run is still in flight", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const targetThreadId = ThreadId.makeUnsafe("thread-heartbeat-target");
      threadShell = Option.some(makeThreadShell({ id: targetThreadId }));
      const created = yield* service.create({
        ...createInput("local"),
        mode: "heartbeat",
        targetThreadId,
      });

      // First manual run starts and stays in flight (the harness never reconciles it).
      const first = yield* service.runNow({ automationId: created.id });
      assert.strictEqual(first.run.status, "running");

      // A second manual run must be rejected rather than racing the same thread.
      const second = yield* service.runNow({ automationId: created.id }).pipe(Effect.flip);
      assert.match(second.message, /already has a run in progress/);

      // No second turn was dispatched: only the first run's turn.start reached the engine.
      assert.strictEqual(
        dispatchedCommands.filter((command) => command.type === "thread.turn.start").length,
        1,
      );
    }),
  );

  it.effect("allows concurrent manual runs for standalone automations", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const created = yield* service.create(createInput("local"));

      // Standalone runs spawn independent threads, so a second manual run is fine.
      const first = yield* service.runNow({ automationId: created.id });
      const second = yield* service.runNow({ automationId: created.id });

      assert.strictEqual(first.run.status, "running");
      assert.strictEqual(second.run.status, "running");
      assert.notStrictEqual(first.run.id, second.run.id);
    }),
  );
});
