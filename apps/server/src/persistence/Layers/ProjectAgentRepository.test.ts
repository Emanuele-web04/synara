import {
  ProjectGoalId,
  ProjectId,
  ProjectTaskAttemptId,
  ProjectTaskId,
  ProjectDocumentRevisionId,
  ThreadId,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { ProjectAgentRepository } from "../Services/ProjectAgentRepository.ts";
import { ProjectAgentRepositoryLive } from "./ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectAgentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.makeUnsafe("project-coord-1");
const coordinatorThreadId = ThreadId.makeUnsafe("thread-coordinator");
const now = "2026-09-15T12:00:00.000Z";
const limits = {
  maxConcurrentWorkers: 2,
  maxNewWorkersPerTurn: 4,
  maxWorkerCreationsPerGoal: 12,
  maxAutomaticContinuationsPerGoal: 20,
  maxRepairRoundsPerTask: 2,
};

layer("ProjectAgentRepository", (it) => {
  it.effect("CAS config writes reject stale revisions", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const config = {
        projectId,
        coordinatorThreadId,
        coordinatorName: "Demo Coordinator",
        coordinatorModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
        limits,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      yield* repository.saveConfig(config, null);
      const stale = yield* Effect.exit(
        repository.saveConfig({ ...config, revision: 2, coordinatorName: "Stale" }, 0),
      );
      assert.equal(Exit.isFailure(stale), true);
      const loaded = yield* repository.getConfig(projectId);
      assert.equal(Option.isSome(loaded), true);
      if (Option.isSome(loaded)) {
        assert.equal(loaded.value.coordinatorName, "Demo Coordinator");
      }
    }),
  );

  it.effect("document writes require the expected revision", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const first = yield* repository.writeDocument({
        expectedRevision: null,
        revision: {
          id: ProjectDocumentRevisionId.makeUnsafe("rev-1"),
          projectId,
          logicalPath: "notes.md",
          revision: 1,
          content: "one",
          contentHash: "h1",
          authorKind: "user",
          authorThreadId: null,
          sources: [],
          createdAt: now,
        },
      });
      assert.equal(first.revision, 1);
      const conflict = yield* Effect.exit(
        repository.writeDocument({
          expectedRevision: 0,
          revision: {
            id: ProjectDocumentRevisionId.makeUnsafe("rev-2"),
            projectId,
            logicalPath: "notes.md",
            revision: 2,
            content: "two",
            contentHash: "h2",
            authorKind: "user",
            authorThreadId: null,
            sources: [],
            createdAt: now,
          },
        }),
      );
      assert.equal(Exit.isFailure(conflict), true);
    }),
  );

  it.effect("stores attempts without implying task completion", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectAgentRepository;
      const goalId = ProjectGoalId.makeUnsafe("goal-1");
      const taskId = ProjectTaskId.makeUnsafe("task-1");
      yield* repository.saveGoal(
        {
          id: goalId,
          projectId,
          objective: "Ship coordinator",
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
          id: taskId,
          projectId,
          goalId,
          title: "Implement persistence",
          description: null,
          acceptanceCriteria: "Tables exist",
          status: "running",
          dependsOnTaskIds: [],
          assignedThreadId: ThreadId.makeUnsafe("thread-worker"),
          repairCount: 0,
          archivedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        null,
      );
      yield* repository.saveAttempt({
        id: ProjectTaskAttemptId.makeUnsafe("attempt-1"),
        projectId,
        taskId,
        workerThreadId: ThreadId.makeUnsafe("thread-worker"),
        gatewayOperationId: null,
        requestId: "op-1",
        attemptNumber: 1,
        outcome: "succeeded",
        error: null,
        createdAt: now,
        finishedAt: now,
      });
      const task = yield* repository.getTask(taskId);
      assert.equal(Option.isSome(task), true);
      if (Option.isSome(task)) {
        assert.equal(task.value.status, "running");
      }
    }),
  );
});
