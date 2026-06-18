import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  AutomationRunId,
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
// Configurable thread shell returned by the ProjectionSnapshotQuery mock; reconcile
// tests set it to drive the run's latest-turn outcome.
let threadShell: Option.Option<OrchestrationThreadShell> = Option.none();
// When set, the orchestration dispatch mock fails on the matching command type so we
// can exercise the failed-run / advance-after-dispatch paths.
let failDispatchType: OrchestrationCommand["type"] | null = null;

function resetHarness() {
  dispatchedCommands.length = 0;
  createdWorktrees.length = 0;
  gitMode = "nonRepo";
  threadShell = Option.none();
  failDispatchType = null;
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
      : Effect.sync(() => {
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
    Effect.succeed({
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

  it.effect("skips a due run while a prior run is in flight but advances the schedule", () =>
    Effect.gen(function* () {
      resetHarness();
      const service = yield* AutomationService;
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-in-flight");

      yield* repository.createDefinition({
        id: automationId,
        input: {
          ...createInput("local"),
          schedule: { type: "interval", everySeconds: 300 },
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      // First due tick creates + dispatches a run that stays running (no reconcile).
      const first = yield* service.runDueOnce({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });
      assert.strictEqual(first.length, 1);
      assert.strictEqual(dispatchedCommands.length, 2);
      const dispatchedBefore = dispatchedCommands.length;

      // Second due tick: the prior run is still active, so no new run is dispatched,
      // but the schedule still advances past this occurrence.
      const second = yield* service.runDueOnce({
        now: "2026-06-16T10:05:00.000Z",
        limit: 10,
        leaseOwnerId: "test-scheduler",
      });

      assert.strictEqual(second.length, 0);
      assert.strictEqual(dispatchedCommands.length, dispatchedBefore);
      const reloaded = yield* service.list({ projectId });
      const definition = reloaded.definitions.find((entry) => entry.id === automationId);
      assert.strictEqual(definition?.nextRunAt, "2026-06-16T10:10:00.000Z");
      // Only the first occurrence produced a run row.
      assert.strictEqual(
        reloaded.runs.filter((entry) => entry.automationId === automationId).length,
        1,
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
