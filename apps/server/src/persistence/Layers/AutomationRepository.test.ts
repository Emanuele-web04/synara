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
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { runMigrations } from "../Migrations.ts";
import { AutomationRepositoryLive } from "./AutomationRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";

const layer = it.layer(AutomationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const createInput = {
  name: "Nightly maintenance",
  projectId: ProjectId.makeUnsafe("project-1"),
  prompt: "Check stale dependencies.",
  schedule: { type: "manual" },
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  },
} satisfies AutomationCreateInput;

const createInputForProject = (projectId: string) => ({
  ...createInput,
  projectId: ProjectId.makeUnsafe(projectId),
});

const permissionSnapshot = {
  provider: "codex",
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  worktreeMode: "worktree",
  allowedCapabilities: ["send-turn", "create-worktree"],
  createdAt: "2026-06-16T10:00:00.000Z",
} as const;

layer("AutomationRepository", (it) => {
  it.effect("creates and lists automation definitions with approval-required defaults", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      const created = yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-1"),
        input: createInputForProject("project-1"),
        now: "2026-06-16T10:00:00.000Z",
      });
      const listed = yield* repository.list({ includeArchived: false });

      assert.strictEqual(created.runtimeMode, "approval-required");
      assert.strictEqual(created.worktreeMode, "auto");
      assert.strictEqual(listed.definitions.length, 1);
      assert.strictEqual(listed.definitions[0]?.id, created.id);
    }),
  );

  it.effect("claims only expired scheduler leases", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      const firstClaim = yield* repository.tryAcquireSchedulerLease({
        leaseKey: "automation-scheduler",
        ownerId: "server-1",
        now: "2026-06-16T10:00:00.000Z",
        leaseExpiresAt: "2026-06-16T10:01:00.000Z",
      });
      const blockedClaim = yield* repository.tryAcquireSchedulerLease({
        leaseKey: "automation-scheduler",
        ownerId: "server-2",
        now: "2026-06-16T10:00:30.000Z",
        leaseExpiresAt: "2026-06-16T10:01:30.000Z",
      });
      const reclaimedClaim = yield* repository.tryAcquireSchedulerLease({
        leaseKey: "automation-scheduler",
        ownerId: "server-2",
        now: "2026-06-16T10:01:01.000Z",
        leaseExpiresAt: "2026-06-16T10:02:01.000Z",
      });

      assert.isTrue(firstClaim);
      assert.isFalse(blockedClaim);
      assert.isTrue(reclaimedClaim);
    }),
  );

  it.effect("dedupes scheduled runs by automation and scheduled time", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-2"),
        input: createInputForProject("project-2"),
        now: "2026-06-16T10:00:00.000Z",
      });
      const first = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-1"),
        automationId: AutomationId.makeUnsafe("automation-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        threadId: null,
        trigger: { type: "scheduled" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:00.000Z",
      });
      const second = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-2"),
        automationId: AutomationId.makeUnsafe("automation-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        trigger: { type: "scheduled" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:01.000Z",
      });

      assert.strictEqual(second.id, first.id);
      assert.isTrue(Option.isSome(yield* repository.getRunById({ id: first.id })));
    }),
  );

  it.effect("marks a run started with thread and command references", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-3"),
        input: createInputForProject("project-3"),
        now: "2026-06-16T10:00:00.000Z",
      });
      const pending = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-3"),
        automationId: AutomationId.makeUnsafe("automation-3"),
        projectId: ProjectId.makeUnsafe("project-3"),
        threadId: null,
        trigger: { type: "manual" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:00.000Z",
      });

      const started = yield* repository.markRunStarted({
        id: pending.id,
        threadId: ThreadId.makeUnsafe("thread-3"),
        messageId: MessageId.makeUnsafe("message-3"),
        threadCreateCommandId: CommandId.makeUnsafe("cmd-thread-create-3"),
        turnStartCommandId: CommandId.makeUnsafe("cmd-turn-start-3"),
        startedAt: "2026-06-16T10:00:02.000Z",
      });

      assert.strictEqual(started.status, "running");
      assert.strictEqual(started.threadId, ThreadId.makeUnsafe("thread-3"));
      assert.strictEqual(started.messageId, MessageId.makeUnsafe("message-3"));
      assert.strictEqual(
        started.threadCreateCommandId,
        CommandId.makeUnsafe("cmd-thread-create-3"),
      );
      assert.strictEqual(started.turnStartCommandId, CommandId.makeUnsafe("cmd-turn-start-3"));
    }),
  );

  it.effect("lists only enabled due definitions", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-4-due"),
        input: {
          ...createInputForProject("project-4"),
          schedule: { type: "interval", everySeconds: 300 },
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      const notDue = yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-4-not-due"),
        input: {
          ...createInputForProject("project-4"),
          name: "Later maintenance",
          schedule: { type: "interval", everySeconds: 300 },
        },
        now: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.setDefinitionNextRunAt({
        id: notDue.id,
        nextRunAt: "2026-06-16T10:10:00.000Z",
        updatedAt: "2026-06-16T10:00:00.000Z",
      });

      const due = yield* repository.listDueDefinitions({
        now: "2026-06-16T10:00:00.000Z",
        limit: 10,
      });

      assert.deepStrictEqual(
        due.map((definition) => definition.id),
        [AutomationId.makeUnsafe("automation-4-due")],
      );
    }),
  );

  it.effect("transitions a run through the terminal mark helpers", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-marks"),
        input: createInputForProject("project-marks"),
        now: "2026-06-16T10:00:00.000Z",
      });

      const seedRun = (suffix: string) =>
        repository.createRun({
          id: AutomationRunId.makeUnsafe(`run-marks-${suffix}`),
          automationId: AutomationId.makeUnsafe("automation-marks"),
          projectId: ProjectId.makeUnsafe("project-marks"),
          threadId: ThreadId.makeUnsafe(`thread-marks-${suffix}`),
          trigger: { type: "manual" },
          scheduledFor: "2026-06-16T10:05:00.000Z",
          permissionSnapshot,
          now: "2026-06-16T10:00:00.000Z",
        });

      yield* seedRun("succeeded");
      const succeeded = yield* repository.markRunSucceeded({
        id: AutomationRunId.makeUnsafe("run-marks-succeeded"),
        turnId: TurnId.makeUnsafe("turn-succeeded"),
        result: null,
        finishedAt: "2026-06-16T10:10:00.000Z",
      });
      assert.strictEqual(succeeded.status, "succeeded");
      assert.strictEqual(succeeded.turnId, TurnId.makeUnsafe("turn-succeeded"));
      assert.strictEqual(succeeded.finishedAt, "2026-06-16T10:10:00.000Z");

      yield* seedRun("interrupted");
      const interrupted = yield* repository.markRunInterrupted({
        id: AutomationRunId.makeUnsafe("run-marks-interrupted"),
        turnId: TurnId.makeUnsafe("turn-interrupted"),
        finishedAt: "2026-06-16T10:11:00.000Z",
      });
      assert.strictEqual(interrupted.status, "interrupted");
      assert.strictEqual(interrupted.turnId, TurnId.makeUnsafe("turn-interrupted"));
      assert.strictEqual(interrupted.finishedAt, "2026-06-16T10:11:00.000Z");

      yield* seedRun("waiting");
      const waiting = yield* repository.markRunWaitingForApproval({
        id: AutomationRunId.makeUnsafe("run-marks-waiting"),
        turnId: TurnId.makeUnsafe("turn-waiting"),
        updatedAt: "2026-06-16T10:12:00.000Z",
      });
      assert.strictEqual(waiting.status, "waiting-for-approval");
      assert.strictEqual(waiting.turnId, TurnId.makeUnsafe("turn-waiting"));
      // waiting-for-approval is non-terminal: no finished_at is recorded.
      assert.strictEqual(waiting.finishedAt, null);

      yield* seedRun("failed");
      const claimed = yield* repository.markRunStarted({
        id: AutomationRunId.makeUnsafe("run-marks-failed"),
        threadId: ThreadId.makeUnsafe("thread-marks-failed"),
        messageId: MessageId.makeUnsafe("message-marks-failed"),
        threadCreateCommandId: CommandId.makeUnsafe("cmd-create-failed"),
        turnStartCommandId: CommandId.makeUnsafe("cmd-turn-failed"),
        startedAt: "2026-06-16T10:00:01.000Z",
      });
      assert.strictEqual(claimed.status, "running");
      const failed = yield* repository.markRunFailed({
        id: AutomationRunId.makeUnsafe("run-marks-failed"),
        error: "boom",
        finishedAt: "2026-06-16T10:13:00.000Z",
      });
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.error, "boom");
      assert.strictEqual(failed.finishedAt, "2026-06-16T10:13:00.000Z");
      // The lease is released so the run is no longer claimed by anyone.
      assert.strictEqual(failed.claimedBy, null);
      assert.strictEqual(failed.leaseExpiresAt, null);
    }),
  );

  it.effect("returns the most recent run for a thread", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-by-thread"),
        input: createInputForProject("project-by-thread"),
        now: "2026-06-16T10:00:00.000Z",
      });
      const threadId = ThreadId.makeUnsafe("thread-shared");

      yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-by-thread-old"),
        automationId: AutomationId.makeUnsafe("automation-by-thread"),
        projectId: ProjectId.makeUnsafe("project-by-thread"),
        threadId,
        trigger: { type: "manual" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-by-thread-new"),
        automationId: AutomationId.makeUnsafe("automation-by-thread"),
        projectId: ProjectId.makeUnsafe("project-by-thread"),
        threadId,
        trigger: { type: "manual" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:01:00.000Z",
      });

      const found = yield* repository.getRunByThreadId({ threadId });
      assert.isTrue(Option.isSome(found));
      assert.strictEqual(
        Option.getOrThrow(found).id,
        AutomationRunId.makeUnsafe("run-by-thread-new"),
      );

      const missing = yield* repository.getRunByThreadId({
        threadId: ThreadId.makeUnsafe("thread-none"),
      });
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("counts only active runs for a definition", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-active-count"),
        input: createInputForProject("project-active-count"),
        now: "2026-06-16T10:00:00.000Z",
      });

      const makeRun = (suffix: string, now: string) =>
        repository.createRun({
          id: AutomationRunId.makeUnsafe(`run-count-${suffix}`),
          automationId: AutomationId.makeUnsafe("automation-active-count"),
          projectId: ProjectId.makeUnsafe("project-active-count"),
          threadId: ThreadId.makeUnsafe(`thread-count-${suffix}`),
          trigger: { type: "manual" },
          scheduledFor: now,
          permissionSnapshot,
          now,
        });

      // pending
      yield* makeRun("pending", "2026-06-16T10:00:00.000Z");
      // running
      yield* makeRun("running", "2026-06-16T10:00:01.000Z");
      yield* repository.markRunStarted({
        id: AutomationRunId.makeUnsafe("run-count-running"),
        threadId: ThreadId.makeUnsafe("thread-count-running"),
        messageId: MessageId.makeUnsafe("message-count-running"),
        threadCreateCommandId: null,
        turnStartCommandId: CommandId.makeUnsafe("cmd-count-running"),
        startedAt: "2026-06-16T10:00:02.000Z",
      });
      // waiting-for-approval
      yield* makeRun("waiting", "2026-06-16T10:00:03.000Z");
      yield* repository.markRunWaitingForApproval({
        id: AutomationRunId.makeUnsafe("run-count-waiting"),
        turnId: null,
        updatedAt: "2026-06-16T10:00:04.000Z",
      });
      // succeeded (NOT active)
      yield* makeRun("done", "2026-06-16T10:00:05.000Z");
      yield* repository.markRunSucceeded({
        id: AutomationRunId.makeUnsafe("run-count-done"),
        turnId: null,
        result: null,
        finishedAt: "2026-06-16T10:00:06.000Z",
      });

      const count = yield* repository.countActiveRunsForDefinition({
        automationId: AutomationId.makeUnsafe("automation-active-count"),
      });
      assert.strictEqual(count, 3);
    }),
  );

  it.effect("disables a definition and clears its next run", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-disable"),
        input: {
          ...createInputForProject("project-disable"),
          schedule: { type: "interval", everySeconds: 300 },
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.disableDefinition({
        id: AutomationId.makeUnsafe("automation-disable"),
        now: "2026-06-16T10:30:00.000Z",
      });

      const reloaded = yield* repository.getDefinitionById({
        id: AutomationId.makeUnsafe("automation-disable"),
      });
      const definition = Option.getOrThrow(reloaded);
      assert.strictEqual(definition.enabled, false);
      assert.strictEqual(definition.nextRunAt, null);
    }),
  );

  it.effect("increments the iteration count", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-iteration"),
        input: createInputForProject("project-iteration"),
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.incrementDefinitionIterationCount({
        id: AutomationId.makeUnsafe("automation-iteration"),
        now: "2026-06-16T10:01:00.000Z",
      });
      yield* repository.incrementDefinitionIterationCount({
        id: AutomationId.makeUnsafe("automation-iteration"),
        now: "2026-06-16T10:02:00.000Z",
      });

      const reloaded = yield* repository.getDefinitionById({
        id: AutomationId.makeUnsafe("automation-iteration"),
      });
      assert.strictEqual(Option.getOrThrow(reloaded).iterationCount, 2);
    }),
  );

  it.effect("never dedupes manual runs sharing a scheduledFor", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-manual-dup"),
        input: createInputForProject("project-manual-dup"),
        now: "2026-06-16T10:00:00.000Z",
      });

      const first = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-manual-1"),
        automationId: AutomationId.makeUnsafe("automation-manual-dup"),
        projectId: ProjectId.makeUnsafe("project-manual-dup"),
        threadId: null,
        trigger: { type: "manual" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:00.000Z",
      });
      const second = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-manual-2"),
        automationId: AutomationId.makeUnsafe("automation-manual-dup"),
        projectId: ProjectId.makeUnsafe("project-manual-dup"),
        threadId: null,
        trigger: { type: "manual" },
        scheduledFor: "2026-06-16T10:05:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:01.000Z",
      });

      // Two distinct rows survive even though they share automation + scheduledFor.
      assert.notStrictEqual(first.id, second.id);
      assert.strictEqual(first.id, AutomationRunId.makeUnsafe("run-manual-1"));
      assert.strictEqual(second.id, AutomationRunId.makeUnsafe("run-manual-2"));
      assert.isTrue(Option.isSome(yield* repository.getRunById({ id: first.id })));
      assert.isTrue(Option.isSome(yield* repository.getRunById({ id: second.id })));
    }),
  );

  it.effect("persists the new definition fields with defaults", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      const created = yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-defaults"),
        input: createInputForProject("project-defaults"),
        now: "2026-06-16T10:00:00.000Z",
      });

      // Defaults applied at create time.
      assert.strictEqual(created.mode, "standalone");
      assert.strictEqual(created.targetThreadId, null);
      assert.strictEqual(created.maxIterations, null);
      assert.strictEqual(created.stopOnError, true);
      assert.strictEqual(created.iterationCount, 0);

      // And they survive a round trip through the DB row decoder.
      const reloaded = Option.getOrThrow(
        yield* repository.getDefinitionById({
          id: AutomationId.makeUnsafe("automation-defaults"),
        }),
      );
      assert.strictEqual(reloaded.mode, "standalone");
      assert.strictEqual(reloaded.targetThreadId, null);
      assert.strictEqual(reloaded.maxIterations, null);
      assert.strictEqual(reloaded.stopOnError, true);
      assert.strictEqual(reloaded.iterationCount, 0);
    }),
  );

  it.effect("persists explicit heartbeat definition fields", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      const created = yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-heartbeat"),
        input: {
          ...createInputForProject("project-heartbeat"),
          mode: "heartbeat",
          targetThreadId: ThreadId.makeUnsafe("thread-target"),
          maxIterations: 5,
          stopOnError: false,
        },
        now: "2026-06-16T10:00:00.000Z",
      });

      const reloaded = Option.getOrThrow(
        yield* repository.getDefinitionById({
          id: AutomationId.makeUnsafe("automation-heartbeat"),
        }),
      );
      assert.strictEqual(reloaded.mode, "heartbeat");
      assert.strictEqual(reloaded.targetThreadId, ThreadId.makeUnsafe("thread-target"));
      assert.strictEqual(reloaded.maxIterations, 5);
      assert.strictEqual(reloaded.stopOnError, false);
    }),
  );

  it.effect("dedupes a scheduled occurrence past a manual run sharing its scheduledFor", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-occurrence"),
        input: createInputForProject("project-occurrence"),
        now: "2026-06-16T10:00:00.000Z",
      });

      const sharedSlot = "2026-06-16T10:05:00.000Z";

      // A manual run lands first, sharing the slot the scheduled occurrence will use.
      const manual = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-occurrence-manual"),
        automationId: AutomationId.makeUnsafe("automation-occurrence"),
        projectId: ProjectId.makeUnsafe("project-occurrence"),
        threadId: null,
        trigger: { type: "manual" },
        scheduledFor: sharedSlot,
        permissionSnapshot,
        now: "2026-06-16T10:00:00.000Z",
      });

      // The scheduled occurrence must read back its OWN row, not the manual one, so the
      // scheduler does not mistake the manual run for a completed scheduled occurrence.
      const scheduled = yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-occurrence-scheduled"),
        automationId: AutomationId.makeUnsafe("automation-occurrence"),
        projectId: ProjectId.makeUnsafe("project-occurrence"),
        threadId: null,
        trigger: { type: "scheduled" },
        scheduledFor: sharedSlot,
        permissionSnapshot,
        now: "2026-06-16T10:00:01.000Z",
      });

      assert.strictEqual(scheduled.id, AutomationRunId.makeUnsafe("run-occurrence-scheduled"));
      assert.strictEqual(scheduled.trigger.type, "scheduled");
      assert.notStrictEqual(scheduled.id, manual.id);
    }),
  );

  it.effect("leaves a terminal run untouched when cancel is requested", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      yield* runMigrations();

      yield* repository.createDefinition({
        id: AutomationId.makeUnsafe("automation-cancel"),
        input: createInputForProject("project-cancel"),
        now: "2026-06-16T10:00:00.000Z",
      });

      yield* repository.createRun({
        id: AutomationRunId.makeUnsafe("run-cancel-done"),
        automationId: AutomationId.makeUnsafe("automation-cancel"),
        projectId: ProjectId.makeUnsafe("project-cancel"),
        threadId: ThreadId.makeUnsafe("thread-cancel-done"),
        trigger: { type: "manual" },
        scheduledFor: "2026-06-16T10:00:00.000Z",
        permissionSnapshot,
        now: "2026-06-16T10:00:00.000Z",
      });
      yield* repository.markRunSucceeded({
        id: AutomationRunId.makeUnsafe("run-cancel-done"),
        turnId: null,
        result: null,
        finishedAt: "2026-06-16T10:01:00.000Z",
      });

      // Cancelling an already-succeeded run is a no-op, not a clobber of its outcome.
      const cancelled = yield* repository.cancelRun({
        runId: AutomationRunId.makeUnsafe("run-cancel-done"),
        now: "2026-06-16T10:05:00.000Z",
      });

      assert.strictEqual(cancelled.status, "succeeded");
      assert.strictEqual(cancelled.finishedAt, "2026-06-16T10:01:00.000Z");
    }),
  );
});
