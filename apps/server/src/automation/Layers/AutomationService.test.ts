import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  ProjectId,
  type AutomationCreateInput,
  type GitCreateWorktreeInput,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepositoryLive } from "../../persistence/Layers/AutomationRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
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

function resetHarness() {
  dispatchedCommands.length = 0;
  createdWorktrees.length = 0;
  gitMode = "nonRepo";
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
    Effect.sync(() => {
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
  getThreadShellById: () => Effect.succeed(Option.none()),
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
});
