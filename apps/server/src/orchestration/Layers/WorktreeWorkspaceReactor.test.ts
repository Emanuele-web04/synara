import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  WorktreeWorkspaceId,
  WorkspaceOperationId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { DevServerManager, type DevServerManagerShape } from "../../devServerManager";
import { GitManagerError } from "../../git/Errors";
import { GitCoreLive } from "../../git/Layers/GitCore";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager";
import { decideOrchestrationCommand } from "../decider";
import { projectEvent } from "../projector";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine";
import { WorktreeWorkspaceReactor } from "../Services/WorktreeWorkspaceReactor";
import {
  resolveWorkspaceBranchProvisioning,
  WorktreeWorkspaceReactorLive,
} from "./WorktreeWorkspaceReactor";

const runtimeSafetyLayer = Layer.merge(
  Layer.succeed(DevServerManager, {
    list: Effect.succeed({ servers: [] }),
    stream: Stream.empty,
    run: () => Effect.die("unused dev-server run"),
    stop: () => Effect.succeed({ stopped: false }),
  } satisfies DevServerManagerShape),
  Layer.succeed(TerminalManager, {
    hasRunningSessionForThreadIds: () => Effect.succeed(false),
    open: () => Effect.die("unused terminal open"),
    write: () => Effect.die("unused terminal write"),
    ackOutput: () => Effect.die("unused terminal ack"),
    resize: () => Effect.die("unused terminal resize"),
    clear: () => Effect.die("unused terminal clear"),
    restart: () => Effect.die("unused terminal restart"),
    close: () => Effect.die("unused terminal close"),
    subscribe: () => Effect.succeed(() => undefined),
    dispose: Effect.void,
  } satisfies TerminalManagerShape),
);

const orchestrationEngineRuntimeStubs = {
  quiesce: Effect.void,
  drain: Effect.void,
  stop: Effect.void,
  getProjectionCatchUpStatus: Effect.succeed({
    state: "healthy" as const,
    inFlight: false,
    retryAttempts: 0,
    lastFailure: null,
  }),
  readEventsThrough: () => Stream.empty,
  getEventHighWaterSequence: Effect.succeed(0),
  subscribeDomainEvents: Effect.succeed(Stream.empty),
} satisfies Pick<
  OrchestrationEngineShape,
  | "quiesce"
  | "drain"
  | "stop"
  | "getProjectionCatchUpStatus"
  | "readEventsThrough"
  | "getEventHighWaterSequence"
  | "subscribeDomainEvents"
>;

const unusedGitManager = () => Effect.die("GitManager should not be used in this test");
const gitManagerLayer = (
  preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = unusedGitManager,
) =>
  Layer.succeed(GitManager, {
    status: unusedGitManager,
    readWorkingTreeDiff: unusedGitManager,
    summarizeDiff: unusedGitManager,
    resolvePullRequest: unusedGitManager,
    listPullRequests: unusedGitManager,
    pullRequestSnapshot: unusedGitManager,
    preparePullRequestThread,
    handoffThread: unusedGitManager,
    runStackedAction: unusedGitManager,
  } satisfies GitManagerShape);

describe("resolveWorkspaceBranchProvisioning", () => {
  it("checks out a free local branch without changing its identity", () => {
    expect(
      resolveWorkspaceBranchProvisioning({
        sourceKind: "branch",
        sourceRef: "feature/existing",
        sourceCommit: "abc123",
        generatedBranch: "synara/generated",
        localBranchExists: true,
        remotes: ["origin"],
      }),
    ).toEqual({ branch: "feature/existing", newBranch: undefined });
  });

  it("creates the matching local branch name for a remote branch", () => {
    expect(
      resolveWorkspaceBranchProvisioning({
        sourceKind: "branch",
        sourceRef: "origin/feature/existing",
        sourceCommit: "abc123",
        generatedBranch: "synara/generated",
        localBranchExists: false,
        remotes: ["origin"],
      }),
    ).toEqual({ branch: "origin/feature/existing", newBranch: "feature/existing" });
  });
});

describe("WorktreeWorkspaceReactor", () => {
  it("backfills legacy conversations by path without changing their content", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-workspace-backfill-"));
    try {
      const repository = join(root, "repository");
      const existingWorktree = join(root, "existing-worktree");
      const missingWorktree = join(root, "missing-worktree");
      const deletedWorktree = join(root, "deleted-worktree");
      mkdirSync(repository);
      mkdirSync(existingWorktree);
      execFileSync("git", ["init", "-b", "actual-main", repository]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Synara Test"]);
      execFileSync("sh", ["-c", "printf fixture > fixture.txt"], { cwd: repository });
      execFileSync("git", ["-C", repository, "add", "fixture.txt"]);
      execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);
      const repositoryHead = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      const now = "2026-07-15T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("project-legacy-backfill");
      const modelSelection = { provider: "codex" as const, model: "gpt-5.5" };
      const legacyThread = (
        id: string,
        title: string,
        worktreePath: string | null,
        branch: string,
        messages: ReadonlyArray<unknown> = [],
      ) =>
        ({
          id: ThreadId.makeUnsafe(id),
          projectId,
          workspaceId: null,
          title,
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: worktreePath ? "worktree" : "local",
          branch,
          worktreePath,
          associatedWorktreePath: worktreePath,
          associatedWorktreeBranch: branch,
          associatedWorktreeRef: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          latestTurn: null,
          handoff: null,
          messages,
          session: null,
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          deletedAt: null,
        }) as unknown as OrchestrationReadModel["threads"][number];
      const preservedMessage = {
        id: "legacy-message",
        role: "user",
        text: "Keep this conversation exactly as it is.",
        streaming: false,
        source: "native",
        turnId: null,
        createdAt: now,
        updatedAt: now,
      };
      let readModel: OrchestrationReadModel = {
        snapshotSequence: 1,
        projects: [
          {
            id: projectId,
            kind: "project",
            title: "Legacy project",
            workspaceRoot: repository,
            defaultModelSelection: modelSelection,
            scripts: [],
            isPinned: false,
            repositoryIdentity: "github.com/example/legacy-project",
            defaultTargetRef: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        workspaces: [],
        threads: [
          legacyThread("root-thread-1", "Root conversation", null, "stale-main", [
            preservedMessage,
          ]),
          legacyThread("root-thread-2", "Another root conversation", null, "stale-main"),
          {
            ...legacyThread("archived-root-thread", "Archived conversation", null, "stale-main"),
            archivedAt: now,
          },
          legacyThread(
            "existing-worktree-thread",
            "Existing worktree conversation",
            existingWorktree,
            "feature/existing",
          ),
          legacyThread(
            "missing-worktree-thread",
            "Missing worktree conversation",
            missingWorktree,
            "feature/missing",
          ),
          {
            ...legacyThread(
              "deleted-worktree-thread",
              "Deleted conversation",
              deletedWorktree,
              "feature/deleted",
            ),
            deletedAt: now,
          },
        ],
        updatedAt: now,
      };
      const commands: OrchestrationCommand[] = [];
      let sequence = readModel.snapshotSequence;
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        ...orchestrationEngineRuntimeStubs,
        readEvents: () => Stream.empty,
        getReadModel: () => Effect.sync(() => readModel),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            const decided = yield* decideOrchestrationCommand({ readModel, command });
            for (const event of Array.isArray(decided) ? decided : [decided]) {
              sequence += 1;
              readModel = yield* projectEvent(readModel, {
                ...event,
                eventId: EventId.makeUnsafe(`legacy-backfill-event-${sequence}`),
                sequence,
              } as OrchestrationEvent);
            }
            return { sequence };
          }),
        repairState: () => Effect.sync(() => readModel),
        refreshCommandReadModel: () => Effect.sync(() => readModel),
        streamDomainEvents: Stream.empty,
      });
      const configLayer = ServerConfig.layerTest(repository, root);
      const gitLayer = GitCoreLive.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const layer = WorktreeWorkspaceReactorLive.pipe(
        Layer.provideMerge(engineLayer),
        Layer.provideMerge(runtimeSafetyLayer),
        Layer.provideMerge(gitManagerLayer()),
        Layer.provideMerge(gitLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* WorktreeWorkspaceReactor;
            yield* reactor.start;
            const commandCountAfterFirstStart = commands.length;
            yield* reactor.start;
            expect(commands).toHaveLength(commandCountAfterFirstStart);
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(commands.filter((command) => command.type === "workspace.import-legacy")).toHaveLength(
        3,
      );
      expect(commands.filter((command) => command.type === "thread.workspace.assign")).toHaveLength(
        5,
      );
      const workspaceByPath = new Map(
        (readModel.workspaces ?? []).map((workspace) => [workspace.path, workspace]),
      );
      const canonicalRepository = realpathSync(repository);
      const canonicalExistingWorktree = realpathSync(existingWorktree);
      expect(workspaceByPath.get(canonicalRepository)).toMatchObject({
        kind: "repository-root",
        state: "ready",
        branch: "actual-main",
        headRef: repositoryHead,
      });
      expect(workspaceByPath.get(canonicalExistingWorktree)).toMatchObject({
        kind: "external",
        state: "ready",
        branch: "feature/existing",
        targetRef: "actual-main",
      });
      expect(workspaceByPath.get(missingWorktree)).toMatchObject({
        kind: "external",
        state: "missing",
        branch: "feature/missing",
      });
      expect(workspaceByPath.has(deletedWorktree)).toBe(false);

      const rootThreadOne = readModel.threads.find((thread) => thread.id === "root-thread-1");
      const rootThreadTwo = readModel.threads.find((thread) => thread.id === "root-thread-2");
      expect(rootThreadOne?.workspaceId).toBe(workspaceByPath.get(canonicalRepository)?.id);
      expect(rootThreadTwo?.workspaceId).toBe(rootThreadOne?.workspaceId);
      expect(rootThreadOne).toMatchObject({
        id: "root-thread-1",
        title: "Root conversation",
        modelSelection,
        messages: [preservedMessage],
        archivedAt: null,
        deletedAt: null,
      });
      expect(
        readModel.threads.find((thread) => thread.id === "archived-root-thread"),
      ).toMatchObject({
        workspaceId: rootThreadOne?.workspaceId,
        archivedAt: now,
        deletedAt: null,
      });
      expect(
        readModel.threads.find((thread) => thread.id === "deleted-worktree-thread"),
      ).toMatchObject({
        workspaceId: null,
        deletedAt: now,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates one worktree, runs setup, and records a fenced completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-workspace-reactor-"));
    try {
      const repository = join(root, "repository");
      execFileSync("git", ["init", "-b", "main", repository]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Synara Test"]);
      execFileSync("sh", ["-c", "printf fixture > fixture.txt"], { cwd: repository });
      execFileSync("git", ["-C", repository, "add", "fixture.txt"]);
      execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);
      const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const now = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe("project-lifecycle");
      const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-lifecycle");
      const operationId = WorkspaceOperationId.makeUnsafe("operation-lifecycle");
      const readModel: OrchestrationReadModel = {
        snapshotSequence: 1,
        projects: [
          {
            id: projectId,
            kind: "project",
            title: "Lifecycle project",
            workspaceRoot: repository,
            defaultModelSelection: null,
            scripts: [
              {
                id: "setup-script",
                name: "Setup",
                command: "printf ready > setup-marker.txt",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
            isPinned: false,
            repositoryIdentity: repository,
            defaultTargetRef: "main",
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        workspaces: [
          {
            id: workspaceId,
            projectId,
            repositoryIdentity: repository,
            kind: "managed",
            state: "provisioning",
            title: "Lifecycle workspace",
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
              id: operationId,
              generation: 1,
              kind: "provision",
              stage: "intent-recorded",
              startedAt: now,
            },
            lastFailure: null,
            mutationRevision: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
        ],
        threads: [],
        updatedAt: now,
      };
      const commands: OrchestrationCommand[] = [];
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        ...orchestrationEngineRuntimeStubs,
        readEvents: () => Stream.empty,
        getReadModel: () => Effect.succeed(readModel),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length + 1 };
          }),
        repairState: () => Effect.succeed(readModel),
        refreshCommandReadModel: () => Effect.succeed(readModel),
        streamDomainEvents: Stream.empty,
      });
      const configLayer = ServerConfig.layerTest(repository, root);
      const gitLayer = GitCoreLive.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const layer = WorktreeWorkspaceReactorLive.pipe(
        Layer.provideMerge(engineLayer),
        Layer.provideMerge(runtimeSafetyLayer),
        Layer.provideMerge(gitManagerLayer()),
        Layer.provideMerge(gitLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* WorktreeWorkspaceReactor;
            yield* reactor.start;
            for (let attempt = 0; attempt < 80 && commands.length === 0; attempt += 1) {
              yield* Effect.sleep(25);
            }
          }),
        ).pipe(Effect.provide(layer)),
      );

      const completion = commands.find(
        (command) => command.type === "workspace.provision.complete",
      );
      expect(completion).toMatchObject({
        workspaceId,
        operationId,
        generation: 1,
        targetResolvedCommit: head,
        createdFromCommit: head,
        setupStatus: "succeeded",
      });
      if (!completion || completion.type !== "workspace.provision.complete") {
        throw new Error("Expected workspace completion command");
      }
      expect(existsSync(join(completion.path, "setup-marker.txt"))).toBe(true);
      expect(
        execFileSync("git", ["-C", repository, "worktree", "list", "--porcelain"], {
          encoding: "utf8",
        }).match(/^worktree /gm),
      ).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks out an existing branch while keeping the default branch as its target", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-existing-branch-reactor-"));
    try {
      const repository = join(root, "repository");
      execFileSync("git", ["init", "-b", "main", repository]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Synara Test"]);
      execFileSync("sh", ["-c", "printf base > fixture.txt"], { cwd: repository });
      execFileSync("git", ["-C", repository, "add", "fixture.txt"]);
      execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
      const targetHead = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["-C", repository, "checkout", "-b", "feature/existing"]);
      execFileSync("sh", ["-c", "printf feature > feature.txt"], { cwd: repository });
      execFileSync("git", ["-C", repository, "add", "feature.txt"]);
      execFileSync("git", ["-C", repository, "commit", "-m", "feature"]);
      const sourceHead = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["-C", repository, "checkout", "main"]);

      const now = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe("project-existing-branch");
      const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-existing-branch");
      const operationId = WorkspaceOperationId.makeUnsafe("operation-existing-branch");
      const readModel: OrchestrationReadModel = {
        snapshotSequence: 1,
        projects: [
          {
            id: projectId,
            kind: "project",
            title: "Existing branch project",
            workspaceRoot: repository,
            defaultModelSelection: null,
            scripts: [],
            isPinned: false,
            repositoryIdentity: repository,
            defaultTargetRef: "main",
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        workspaces: [
          {
            id: workspaceId,
            projectId,
            repositoryIdentity: repository,
            kind: "managed",
            state: "provisioning",
            title: "Existing branch workspace",
            path: null,
            branch: null,
            headRef: null,
            targetRef: "main",
            targetResolvedCommit: null,
            createdFromCommit: null,
            sourceKind: "branch",
            sourceRef: "feature/existing",
            setupStatus: "pending",
            setupError: null,
            setupLogId: null,
            lastKnownPr: null,
            isPinned: false,
            lifecycleGeneration: 1,
            activeOperation: {
              id: operationId,
              generation: 1,
              kind: "provision",
              stage: "intent-recorded",
              startedAt: now,
            },
            lastFailure: null,
            mutationRevision: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
        ],
        threads: [],
        updatedAt: now,
      };
      const commands: OrchestrationCommand[] = [];
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        ...orchestrationEngineRuntimeStubs,
        readEvents: () => Stream.empty,
        getReadModel: () => Effect.succeed(readModel),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length + 1 };
          }),
        repairState: () => Effect.succeed(readModel),
        refreshCommandReadModel: () => Effect.succeed(readModel),
        streamDomainEvents: Stream.empty,
      });
      const configLayer = ServerConfig.layerTest(repository, root);
      const gitLayer = GitCoreLive.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const layer = WorktreeWorkspaceReactorLive.pipe(
        Layer.provideMerge(engineLayer),
        Layer.provideMerge(runtimeSafetyLayer),
        Layer.provideMerge(gitManagerLayer()),
        Layer.provideMerge(gitLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const reactor = yield* WorktreeWorkspaceReactor;
            yield* reactor.start;
            for (let attempt = 0; attempt < 80 && commands.length === 0; attempt += 1) {
              yield* Effect.sleep(25);
            }
          }),
        ).pipe(Effect.provide(layer)),
      );

      const completion = commands.find(
        (command) => command.type === "workspace.provision.complete",
      );
      expect(completion).toMatchObject({
        workspaceId,
        operationId,
        branch: "feature/existing",
        targetResolvedCommit: targetHead,
        createdFromCommit: sourceHead,
        setupStatus: "skipped",
      });
      if (!completion || completion.type !== "workspace.provision.complete") {
        throw new Error("Expected workspace completion command");
      }
      expect(existsSync(join(completion.path, "feature.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes and reuses a generation-fenced PR retry at the deterministic managed path", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-pr-reactor-"));
    try {
      const repository = join(root, "repository");
      execFileSync("git", ["init", "-b", "main", repository]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Synara Test"]);
      execFileSync("sh", ["-c", "printf base > fixture.txt"], { cwd: repository });
      execFileSync("git", ["-C", repository, "add", "fixture.txt"]);
      execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
      const targetCommit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      const now = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe("project-pr-reactor");
      const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-pr-reactor");
      const operationId = WorkspaceOperationId.makeUnsafe("operation-pr-reactor");
      const managedPath = join(root, "worktrees", String(projectId), String(workspaceId));
      const readModel: OrchestrationReadModel = {
        snapshotSequence: 1,
        projects: [
          {
            id: projectId,
            kind: "project",
            title: "PR project",
            workspaceRoot: repository,
            defaultModelSelection: null,
            scripts: [],
            isPinned: false,
            repositoryIdentity: "github.com/acme/repo",
            defaultTargetRef: "main",
            githubAccount: { host: "github.com", login: "reviewer" },
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        workspaces: [
          {
            id: workspaceId,
            projectId,
            repositoryIdentity: "github.com/acme/repo",
            kind: "managed",
            state: "provisioning",
            title: "Review fork PR",
            path: null,
            branch: "fork-head",
            headRef: null,
            targetRef: "main",
            targetResolvedCommit: null,
            createdFromCommit: null,
            sourceKind: "pull-request",
            sourceRef: "https://github.com/acme/repo/pull/42",
            setupStatus: "pending",
            setupError: null,
            setupLogId: null,
            lastKnownPr: {
              number: 42,
              title: "Review fork PR",
              url: "https://github.com/acme/repo/pull/42",
              baseBranch: "main",
              headBranch: "fork-head",
              state: "open",
            },
            isPinned: false,
            lifecycleGeneration: 2,
            activeOperation: {
              id: operationId,
              generation: 2,
              kind: "provision",
              stage: "intent-recorded",
              startedAt: now,
            },
            lastFailure: null,
            mutationRevision: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
        ],
        threads: [],
        updatedAt: now,
      };
      const commands: OrchestrationCommand[] = [];
      const prepareCalls: Parameters<GitManagerShape["preparePullRequestThread"]>[0][] = [];
      const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = (input) =>
        Effect.sync(() => {
          prepareCalls.push(input);
          if (!existsSync(managedPath)) {
            execFileSync("git", [
              "-C",
              repository,
              "worktree",
              "add",
              "-b",
              "synara/pr-42/fork-head",
              managedPath,
              "main",
            ]);
          }
          return {
            pullRequest: {
              number: 42,
              title: "Review fork PR",
              url: "https://github.com/acme/repo/pull/42",
              baseBranch: "develop",
              headBranch: "fork-head",
              state: "open" as const,
              isDraft: false,
              mergeability: "mergeable" as const,
              additions: 10,
              deletions: 2,
              changedFiles: 3,
            },
            branch: "synara/pr-42/fork-head",
            worktreePath: managedPath,
            targetResolvedCommit: targetCommit,
          };
        });
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        ...orchestrationEngineRuntimeStubs,
        readEvents: () => Stream.empty,
        getReadModel: () => Effect.succeed(readModel),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length + 1 };
          }),
        repairState: () => Effect.succeed(readModel),
        refreshCommandReadModel: () => Effect.succeed(readModel),
        streamDomainEvents: Stream.empty,
      });
      const configLayer = ServerConfig.layerTest(repository, root);
      const gitLayer = GitCoreLive.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const layer = WorktreeWorkspaceReactorLive.pipe(
        Layer.provideMerge(engineLayer),
        Layer.provideMerge(runtimeSafetyLayer),
        Layer.provideMerge(gitManagerLayer(preparePullRequestThread)),
        Layer.provideMerge(gitLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const runReactor = () => {
        const expectedCompletions =
          commands.filter((command) => command.type === "workspace.provision.complete").length + 1;
        return Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* WorktreeWorkspaceReactor).start;
              for (
                let attempt = 0;
                attempt < 80 &&
                commands.filter((command) => command.type === "workspace.provision.complete")
                  .length < expectedCompletions;
                attempt += 1
              ) {
                yield* Effect.sleep(25);
              }
            }),
          ).pipe(Effect.provide(layer)),
        );
      };

      await runReactor();
      await runReactor();

      expect(prepareCalls).toHaveLength(2);
      for (const call of prepareCalls) {
        expect(call).toEqual({
          cwd: repository,
          reference: "https://github.com/acme/repo/pull/42",
          mode: "worktree",
          managedWorktreePath: managedPath,
          account: { host: "github.com", login: "reviewer" },
        });
      }
      const completions = commands.filter(
        (command) => command.type === "workspace.provision.complete",
      );
      expect(completions).toHaveLength(2);
      expect(completions[0]).toMatchObject({
        workspaceId,
        operationId,
        generation: 2,
        path: managedPath,
        branch: "synara/pr-42/fork-head",
        targetResolvedCommit: targetCommit,
        targetRef: "develop",
        lastKnownPr: {
          number: 42,
          baseBranch: "develop",
          headBranch: "fork-head",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a deterministic managed-path collision without retry mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-pr-collision-reactor-"));
    try {
      const repository = join(root, "repository");
      execFileSync("git", ["init", "-b", "main", repository]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Synara Test"]);
      execFileSync("sh", ["-c", "printf base > fixture.txt"], { cwd: repository });
      execFileSync("git", ["-C", repository, "add", "fixture.txt"]);
      execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
      const now = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe("project-pr-collision");
      const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-pr-collision");
      const operationId = WorkspaceOperationId.makeUnsafe("operation-pr-collision");
      const managedPath = join(root, "worktrees", String(projectId), String(workspaceId));
      mkdirSync(managedPath, { recursive: true });
      const readModel = {
        snapshotSequence: 1,
        projects: [
          {
            id: projectId,
            kind: "project" as const,
            title: "Collision project",
            workspaceRoot: repository,
            defaultModelSelection: null,
            scripts: [],
            isPinned: false,
            repositoryIdentity: "github.com/acme/repo",
            defaultTargetRef: "main",
            githubAccount: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        workspaces: [
          {
            id: workspaceId,
            projectId,
            repositoryIdentity: "github.com/acme/repo",
            kind: "managed" as const,
            state: "provisioning" as const,
            title: "Collision PR",
            path: null,
            branch: "feature/collision",
            headRef: null,
            targetRef: "main",
            targetResolvedCommit: null,
            createdFromCommit: null,
            sourceKind: "pull-request" as const,
            sourceRef: "https://github.com/acme/repo/pull/43",
            setupStatus: "pending" as const,
            setupError: null,
            setupLogId: null,
            lastKnownPr: {
              number: 43,
              title: "Collision PR",
              url: "https://github.com/acme/repo/pull/43",
              baseBranch: "main",
              headBranch: "feature/collision",
              state: "open" as const,
            },
            isPinned: false,
            lifecycleGeneration: 1,
            activeOperation: {
              id: operationId,
              generation: 1,
              kind: "provision" as const,
              stage: "intent-recorded",
              startedAt: now,
            },
            lastFailure: null,
            mutationRevision: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
        ],
        threads: [],
        updatedAt: now,
      } satisfies OrchestrationReadModel;
      const commands: OrchestrationCommand[] = [];
      let prepareCalls = 0;
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        ...orchestrationEngineRuntimeStubs,
        readEvents: () => Stream.empty,
        getReadModel: () => Effect.succeed(readModel),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length + 1 };
          }),
        repairState: () => Effect.succeed(readModel),
        refreshCommandReadModel: () => Effect.succeed(readModel),
        streamDomainEvents: Stream.empty,
      });
      const configLayer = ServerConfig.layerTest(repository, root);
      const gitLayer = GitCoreLive.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const layer = WorktreeWorkspaceReactorLive.pipe(
        Layer.provideMerge(engineLayer),
        Layer.provideMerge(runtimeSafetyLayer),
        Layer.provideMerge(
          gitManagerLayer(() => {
            prepareCalls += 1;
            return Effect.fail(
              new GitManagerError({
                operation: "preparePullRequestThread",
                detail: `The managed worktree path '${managedPath}' is already occupied.`,
              }),
            );
          }),
        ),
        Layer.provideMerge(gitLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* WorktreeWorkspaceReactor).start;
            for (let attempt = 0; attempt < 80 && commands.length === 0; attempt += 1) {
              yield* Effect.sleep(25);
            }
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(prepareCalls).toBe(1);
      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "workspace.operation.fail",
          workspaceId,
          operationId,
          generation: 1,
          kind: "provision",
          stage: "prepare-pull-request",
          path: null,
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archives a clean managed worktree without deleting its branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "synara-archive-reactor-"));
    try {
      const repository = join(root, "repository");
      const worktreePath = join(root, "managed-worktree");
      execFileSync("git", ["init", "-b", "main", repository]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Synara Test"]);
      execFileSync("sh", ["-c", "printf base > fixture.txt"], { cwd: repository });
      execFileSync("git", ["-C", repository, "add", "fixture.txt"]);
      execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
      execFileSync("git", [
        "-C",
        repository,
        "worktree",
        "add",
        "-b",
        "feature/archive-me",
        worktreePath,
        "main",
      ]);
      const head = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const now = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe("project-archive-reactor");
      const workspaceId = WorktreeWorkspaceId.makeUnsafe("workspace-archive-reactor");
      const operationId = WorkspaceOperationId.makeUnsafe("operation-archive-reactor");
      let readModel: OrchestrationReadModel = {
        snapshotSequence: 1,
        projects: [
          {
            id: projectId,
            kind: "project",
            title: "Archive project",
            workspaceRoot: repository,
            defaultModelSelection: null,
            scripts: [],
            isPinned: false,
            repositoryIdentity: repository,
            defaultTargetRef: "main",
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        workspaces: [
          {
            id: workspaceId,
            projectId,
            repositoryIdentity: repository,
            kind: "managed",
            state: "archiving",
            title: "Archive me",
            path: worktreePath,
            branch: "feature/archive-me",
            headRef: head,
            targetRef: "main",
            targetResolvedCommit: head,
            createdFromCommit: head,
            sourceKind: "new-branch",
            sourceRef: "main",
            setupStatus: "skipped",
            setupError: null,
            setupLogId: null,
            lastKnownPr: null,
            isPinned: false,
            lifecycleGeneration: 2,
            activeOperation: {
              id: operationId,
              generation: 2,
              kind: "archive",
              stage: "intent-confirmed",
              startedAt: now,
            },
            lastFailure: null,
            mutationRevision: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
        ],
        threads: [],
        updatedAt: now,
      };
      const commands: OrchestrationCommand[] = [];
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        ...orchestrationEngineRuntimeStubs,
        readEvents: () => Stream.empty,
        getReadModel: () => Effect.succeed(readModel),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length + 1 };
          }),
        repairState: () => Effect.succeed(readModel),
        refreshCommandReadModel: () => Effect.succeed(readModel),
        streamDomainEvents: Stream.empty,
      });
      const configLayer = ServerConfig.layerTest(repository, root);
      const gitLayer = GitCoreLive.pipe(
        Layer.provide(configLayer),
        Layer.provide(NodeServices.layer),
      );
      const layer = WorktreeWorkspaceReactorLive.pipe(
        Layer.provideMerge(engineLayer),
        Layer.provideMerge(runtimeSafetyLayer),
        Layer.provideMerge(gitManagerLayer()),
        Layer.provideMerge(gitLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* WorktreeWorkspaceReactor).start;
            for (let attempt = 0; attempt < 80 && commands.length === 0; attempt += 1) {
              yield* Effect.sleep(25);
            }
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "workspace.archive.complete",
          workspaceId,
          operationId,
          generation: 2,
        }),
      );
      expect(existsSync(worktreePath)).toBe(false);
      expect(
        execFileSync("git", [
          "-C",
          repository,
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/feature/archive-me",
        ]),
      ).toBeDefined();

      const restoreOperationId = WorkspaceOperationId.makeUnsafe("operation-restore-reactor");
      const archivedWorkspace = readModel.workspaces?.[0];
      expect(archivedWorkspace).toBeDefined();
      readModel = {
        ...readModel,
        workspaces: [
          {
            ...archivedWorkspace!,
            state: "provisioning",
            lifecycleGeneration: 3,
            activeOperation: {
              id: restoreOperationId,
              generation: 3,
              kind: "restore",
              stage: "intent-recorded",
              startedAt: now,
            },
            archivedAt: now,
          },
          ...(readModel.workspaces?.slice(1) ?? []),
        ],
      };
      commands.length = 0;

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* WorktreeWorkspaceReactor).start;
            for (let attempt = 0; attempt < 80 && commands.length === 0; attempt += 1) {
              yield* Effect.sleep(25);
            }
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "workspace.restore.complete",
          workspaceId,
          operationId: restoreOperationId,
          generation: 3,
          path: worktreePath,
          branch: "feature/archive-me",
          headRef: head,
        }),
      );
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
