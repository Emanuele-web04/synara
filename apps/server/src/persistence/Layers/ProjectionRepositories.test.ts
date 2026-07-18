import { ProjectId, ThreadId, WorktreeWorkspaceId, WorkspaceOperationId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionStateRepositoryLive } from "./ProjectionState.ts";
import { ProjectionWorktreeWorkspaceRepositoryLive } from "./ProjectionWorktreeWorkspaces.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionStateRepository } from "../Services/ProjectionState.ts";
import { ProjectionWorktreeWorkspaceRepository } from "../Services/ProjectionWorktreeWorkspaces.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionStateRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionWorktreeWorkspaceRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.makeUnsafe("project-null-options"),
        kind: "project",
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        scripts: [],
        isPinned: false,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
        readonly githubAccount: string | null;
      }>`
        SELECT
          default_model_selection_json AS "defaultModelSelection",
          github_account_json AS "githubAccount"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_projects row to exist."));
      }

      assert.strictEqual(
        row.defaultModelSelection,
        JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
        }),
      );
      assert.strictEqual(row.githubAccount, null);

      const persisted = yield* projects.getById({
        projectId: ProjectId.makeUnsafe("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.makeUnsafe("thread-null-options"),
        projectId: ProjectId.makeUnsafe("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
        createBranchFlowCompleted: false,
        lastKnownPr: null,
        latestTurnId: null,
        handoff: null,
        pinnedMessages: null,
        threadMarkers: null,
        notes: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_threads row to exist."));
      }

      assert.strictEqual(
        row.modelSelection,
        JSON.stringify({
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.makeUnsafe("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("keeps projection cursors monotonic during concurrent catch-up", () =>
    Effect.gen(function* () {
      const states = yield* ProjectionStateRepository;

      yield* states.upsert({
        projector: "projection.hot",
        lastAppliedSequence: 20,
        updatedAt: "2026-07-09T00:00:20.000Z",
      });
      yield* states.upsert({
        projector: "projection.hot",
        lastAppliedSequence: 10,
        updatedAt: "2026-07-09T00:00:10.000Z",
      });

      const persisted = yield* states.getByProjector({ projector: "projection.hot" });
      assert.deepStrictEqual(Option.getOrNull(persisted), {
        projector: "projection.hot",
        lastAppliedSequence: 20,
        updatedAt: "2026-07-09T00:00:20.000Z",
      });
    }),
  );

  it.effect("round-trips workspace lifecycle metadata", () =>
    Effect.gen(function* () {
      const workspaces = yield* ProjectionWorktreeWorkspaceRepository;
      const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-roundtrip");
      yield* workspaces.upsert({
        workspaceId,
        projectId: ProjectId.makeUnsafe("project-null-options"),
        repositoryIdentity: "repo:roundtrip",
        kind: "managed",
        state: "provisioning",
        title: "Roundtrip workspace",
        path: null,
        branch: null,
        headRef: null,
        targetRef: "main",
        targetResolvedCommit: null,
        createdFromCommit: null,
        sourceKind: "new-branch",
        sourceRef: "main",
        setupStatus: "pending",
        setupError: null,
        setupLogId: null,
        lastKnownPr: null,
        isPinned: false,
        lifecycleGeneration: 1,
        activeOperation: {
          id: WorkspaceOperationId.makeUnsafe("operation-roundtrip"),
          generation: 1,
          kind: "provision",
          stage: "intent-recorded",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        lastFailure: null,
        mutationRevision: 0,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
      });

      const persisted = yield* workspaces.getById({ workspaceId });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.activeOperation, {
        id: WorkspaceOperationId.makeUnsafe("operation-roundtrip"),
        generation: 1,
        kind: "provision",
        stage: "intent-recorded",
        startedAt: "2026-07-13T00:00:00.000Z",
      });
    }),
  );
});
