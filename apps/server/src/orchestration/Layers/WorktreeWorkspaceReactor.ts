import { exec } from "node:child_process";
import { createHash } from "node:crypto";

import {
  CommandId,
  type ProjectId,
  type OrchestrationWorktreeWorkspace,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { makeDrainableWorker } from "@synara/shared/DrainableWorker";
import { Cause, Effect, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "../../config";
import { DevServerManager } from "../../devServerManager";
import { GitCore } from "../../git/Services/GitCore";
import { GitManager } from "../../git/Services/GitManager";
import { TerminalManager } from "../../terminal/Services/Manager";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine";
import { getWorkspaceLifecyclePreflight } from "../workspaceLifecyclePreflight";
import {
  WorktreeWorkspaceReactor,
  type WorktreeWorkspaceReactorShape,
} from "../Services/WorktreeWorkspaceReactor";

interface WorkspaceRequest {
  readonly workspaceId: WorktreeWorkspaceId;
  readonly projectId: ProjectId;
}

const commandId = (tag: string, workspaceId: string) =>
  CommandId.makeUnsafe(`server:workspace:${tag}:${workspaceId}:${crypto.randomUUID()}`);

function workspaceBranchName(workspace: OrchestrationWorktreeWorkspace): string {
  const slug = workspace.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return `synara/${slug || "workspace"}-${String(workspace.id).slice(0, 8)}`;
}

export function resolveWorkspaceBranchProvisioning(input: {
  sourceKind: OrchestrationWorktreeWorkspace["sourceKind"];
  sourceRef: string;
  sourceCommit: string;
  generatedBranch: string;
  localBranchExists: boolean;
  remotes: readonly string[];
}): { branch: string; newBranch: string | undefined } {
  if (input.sourceKind !== "branch") {
    return { branch: input.sourceCommit, newBranch: input.generatedBranch };
  }
  if (input.localBranchExists) {
    return { branch: input.sourceRef, newBranch: undefined };
  }
  const remote = input.remotes.find((candidate) => input.sourceRef.startsWith(`${candidate}/`));
  return {
    branch: input.sourceRef,
    newBranch: remote ? input.sourceRef.slice(remote.length + 1) : input.sourceRef,
  };
}

function errorSummary(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (message.trim() || "Workspace provisioning failed").slice(0, 2_000);
}

function legacyWorkspaceId(projectId: ProjectId, canonicalPath: string): WorktreeWorkspaceId {
  const digest = createHash("sha256")
    .update(`${projectId}\0${canonicalPath}`)
    .digest("hex")
    .slice(0, 24);
  return WorktreeWorkspaceId.makeUnsafe(`legacy-${digest}`);
}

function runSetupCommand(command: string, cwd: string) {
  return Effect.callback<void, Error>((resume) => {
    const child = exec(
      command,
      {
        cwd,
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error) => resume(error ? Effect.fail(error) : Effect.void),
    );
    return Effect.sync(() => child.kill());
  });
}

export const makeWorktreeWorkspaceReactor = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitCore;
  const gitManager = yield* GitManager;
  const devServerManager = yield* DevServerManager;
  const terminalManager = yield* TerminalManager;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const path = yield* Path.Path;
  const processing = new Set<string>();

  const canonicalPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.catch(() => Effect.succeed(path.resolve(value))));

  const readLegacyGitValue = (cwd: string, operation: string, args: readonly string[]) =>
    git.execute({ operation, cwd, args, allowNonZeroExit: true }).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() || null : null)),
      Effect.catch(() => Effect.succeed(null)),
    );

  const resolveLegacyProjectTargetRef = Effect.fn(function* (projectPath: string) {
    const remoteHead = yield* readLegacyGitValue(
      projectPath,
      "WorktreeWorkspaceReactor.readLegacyRemoteHead",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    );
    if (remoteHead) {
      return remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
    }
    return yield* readLegacyGitValue(
      projectPath,
      "WorktreeWorkspaceReactor.readLegacyProjectBranch",
      ["branch", "--show-current"],
    );
  });

  const backfillLegacyWorkspaces = Effect.gen(function* () {
    const initial = yield* orchestrationEngine.getReadModel();
    for (const project of initial.projects) {
      if ((project.kind ?? "project") !== "project") continue;
      const projectPath = yield* canonicalPath(project.workspaceRoot);
      const projectTargetRef =
        project.defaultTargetRef ?? (yield* resolveLegacyProjectTargetRef(projectPath));
      const candidates = initial.threads.filter(
        (thread) =>
          thread.projectId === project.id &&
          thread.workspaceId == null &&
          thread.deletedAt === null,
      );
      const groups = new Map<string, typeof candidates>();
      for (const thread of candidates) {
        const legacyPath =
          thread.worktreePath ?? thread.associatedWorktreePath ?? project.workspaceRoot;
        const resolvedPath = yield* canonicalPath(legacyPath);
        groups.set(resolvedPath, [...(groups.get(resolvedPath) ?? []), thread]);
      }

      for (const [resolvedPath, threads] of [...groups.entries()].toSorted(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const current = yield* orchestrationEngine.getReadModel();
        let workspace = (current.workspaces ?? []).find(
          (candidate) => candidate.projectId === project.id && candidate.path === resolvedPath,
        );
        if (!workspace) {
          const first = threads[0];
          if (!first) continue;
          const workspaceId = legacyWorkspaceId(project.id, resolvedPath);
          const workspacePathExists = yield* fileSystem.exists(resolvedPath);
          const currentBranch = workspacePathExists
            ? yield* readLegacyGitValue(resolvedPath, "WorktreeWorkspaceReactor.readLegacyBranch", [
                "branch",
                "--show-current",
              ])
            : null;
          const currentHead = workspacePathExists
            ? yield* readLegacyGitValue(resolvedPath, "WorktreeWorkspaceReactor.readLegacyHead", [
                "rev-parse",
                "HEAD",
              ])
            : null;
          const branch = currentBranch ?? first.branch ?? first.associatedWorktreeBranch ?? null;
          const headRef = currentHead ?? first.associatedWorktreeRef ?? null;
          const createdAt =
            threads.map((thread) => thread.createdAt).toSorted()[0] ?? new Date().toISOString();
          yield* orchestrationEngine.dispatch({
            type: "workspace.import-legacy",
            commandId: CommandId.makeUnsafe(`server:workspace:backfill:${workspaceId}`),
            workspaceId,
            projectId: project.id,
            repositoryIdentity: project.repositoryIdentity ?? project.workspaceRoot,
            kind: resolvedPath === projectPath ? "repository-root" : "external",
            state: workspacePathExists ? "ready" : "missing",
            title: branch ?? path.basename(resolvedPath),
            path: resolvedPath,
            branch,
            headRef,
            targetRef: projectTargetRef ?? branch ?? "HEAD",
            targetResolvedCommit: headRef,
            createdFromCommit: headRef,
            setupStatus: "skipped",
            createdAt,
          });
          workspace = ((yield* orchestrationEngine.getReadModel()).workspaces ?? []).find(
            (candidate) => candidate.id === workspaceId,
          );
        }
        if (!workspace) continue;

        for (const thread of threads) {
          yield* orchestrationEngine.dispatch({
            type: "thread.workspace.assign",
            commandId: CommandId.makeUnsafe(
              `server:workspace:backfill-thread:${thread.id}:${workspace.id}`,
            ),
            threadId: thread.id,
            workspaceId: workspace.id,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("legacy worktree workspace backfill failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const provision = Effect.fn(function* (request: WorkspaceRequest) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const workspace = (readModel.workspaces ?? []).find(
      (candidate) => candidate.id === request.workspaceId,
    );
    const project = readModel.projects.find((candidate) => candidate.id === request.projectId);
    if (
      !workspace ||
      !project ||
      workspace.kind !== "managed" ||
      workspace.state !== "provisioning" ||
      workspace.activeOperation === null
    ) {
      return;
    }

    const operation = workspace.activeOperation;
    const worktreePath = path.join(config.worktreesDir, String(project.id), String(workspace.id));
    const generatedBranch = workspace.branch ?? workspaceBranchName(workspace);
    let stage = "resolve-target";
    let createdPath: string | null = null;
    let createdBranch: string | null = null;
    let createdHead: string | null = null;
    let targetResolvedCommit: string | null = null;
    let createdFromCommit: string | null = null;
    let refreshedPullRequest: OrchestrationWorktreeWorkspace["lastKnownPr"] = null;
    const sourceRef =
      workspace.sourceKind === "branch"
        ? (workspace.sourceRef ?? workspace.targetRef)
        : workspace.targetRef;

    const fail = (cause: unknown) =>
      orchestrationEngine
        .dispatch({
          type: "workspace.operation.fail",
          commandId: commandId("provision-failed", String(workspace.id)),
          workspaceId: workspace.id,
          operationId: operation.id,
          generation: operation.generation,
          kind: stage === "setup" ? "setup" : "provision",
          stage,
          summary: errorSummary(cause),
          logId: null,
          path: createdPath,
          branch: createdBranch,
          headRef: createdHead,
          targetResolvedCommit,
          createdFromCommit,
          failedAt: new Date().toISOString(),
        })
        .pipe(
          Effect.asVoid,
          Effect.catchCause((dispatchCause) =>
            Effect.logWarning("failed to record workspace provisioning failure", {
              workspaceId: workspace.id,
              cause: Cause.pretty(dispatchCause),
            }),
          ),
        );

    yield* Effect.gen(function* () {
      if (workspace.sourceKind === "pull-request") {
        const pullRequestReference = workspace.lastKnownPr?.url ?? workspace.sourceRef;
        if (!pullRequestReference || workspace.lastKnownPr === null) {
          return yield* Effect.fail(
            new Error("Pull-request workspace is missing its durable pull request identity"),
          );
        }

        stage = "prepare-pull-request";
        yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true });
        const prepared = yield* gitManager.preparePullRequestThread({
          cwd: project.workspaceRoot,
          reference: pullRequestReference,
          mode: "worktree",
          managedWorktreePath: worktreePath,
          ...(project.githubAccount ? { account: project.githubAccount } : {}),
        });
        refreshedPullRequest = prepared.pullRequest;
        targetResolvedCommit = prepared.targetResolvedCommit ?? null;
        createdPath = prepared.worktreePath;
        createdBranch = prepared.branch;
        if (!createdPath) {
          return yield* Effect.fail(
            new Error("Pull request preparation did not return a managed worktree path"),
          );
        }
        createdHead = (yield* git.execute({
          operation: "WorktreeWorkspaceReactor.readPullRequestHead",
          cwd: createdPath,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim();
        createdFromCommit = createdHead;

        stage = "resolve-target";
        if (!targetResolvedCommit) {
          const targetCandidates = [
            prepared.pullRequest.baseBranch,
            `origin/${prepared.pullRequest.baseBranch}`,
          ];
          for (const candidate of targetCandidates) {
            const resolved = yield* git.execute({
              operation: "WorktreeWorkspaceReactor.resolvePullRequestTarget",
              cwd: project.workspaceRoot,
              args: ["rev-parse", "--verify", `${candidate}^{commit}`],
              allowNonZeroExit: true,
            });
            if (resolved.code === 0 && resolved.stdout.trim()) {
              targetResolvedCommit = resolved.stdout.trim();
              break;
            }
          }
        }
        if (!targetResolvedCommit) {
          return yield* Effect.fail(
            new Error(`Target '${prepared.pullRequest.baseBranch}' has no local commit`),
          );
        }
      } else {
        stage = "resolve-target";
        targetResolvedCommit = (yield* git.execute({
          operation: "WorktreeWorkspaceReactor.resolveTarget",
          cwd: project.workspaceRoot,
          args: ["rev-parse", "--verify", `${workspace.targetRef}^{commit}`],
        })).stdout.trim();
        if (!targetResolvedCommit) {
          return yield* Effect.fail(new Error(`Target '${workspace.targetRef}' has no commit`));
        }

        const existingPath = yield* fileSystem.exists(worktreePath);
        if (existingPath) {
          stage = "reconcile-worktree";
          createdHead = (yield* git.execute({
            operation: "WorktreeWorkspaceReactor.reconcileHead",
            cwd: worktreePath,
            args: ["rev-parse", "HEAD"],
          })).stdout.trim();
          createdBranch = (yield* git.execute({
            operation: "WorktreeWorkspaceReactor.reconcileBranch",
            cwd: worktreePath,
            args: ["branch", "--show-current"],
          })).stdout.trim();
          if (!createdHead || !createdBranch) {
            return yield* Effect.fail(new Error("Existing worktree has no branch or HEAD commit"));
          }
          createdPath = worktreePath;
          createdFromCommit = createdHead;
        } else {
          stage = "resolve-source";
          if (sourceRef === workspace.targetRef) {
            createdFromCommit = targetResolvedCommit;
          } else {
            createdFromCommit = (yield* git.execute({
              operation: "WorktreeWorkspaceReactor.resolveSource",
              cwd: project.workspaceRoot,
              args: ["rev-parse", "--verify", `${sourceRef}^{commit}`],
            })).stdout.trim();
          }
          if (!createdFromCommit) {
            return yield* Effect.fail(new Error(`Source '${sourceRef}' has no commit`));
          }

          stage = "create-worktree";
          yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true });
          let localBranchExists = false;
          let remotes: readonly string[] = [];
          if (workspace.sourceKind === "branch") {
            const localBranch = yield* git.execute({
              operation: "WorktreeWorkspaceReactor.resolveLocalBranch",
              cwd: project.workspaceRoot,
              args: ["show-ref", "--verify", "--quiet", `refs/heads/${sourceRef}`],
              allowNonZeroExit: true,
            });
            localBranchExists = localBranch.code === 0;
            if (!localBranchExists) {
              remotes = (yield* git.execute({
                operation: "WorktreeWorkspaceReactor.listRemotes",
                cwd: project.workspaceRoot,
                args: ["remote"],
              })).stdout
                .split("\n")
                .map((remote) => remote.trim())
                .filter(Boolean);
            }
          }
          const { branch, newBranch } = resolveWorkspaceBranchProvisioning({
            sourceKind: workspace.sourceKind,
            sourceRef,
            sourceCommit: createdFromCommit,
            generatedBranch,
            localBranchExists,
            remotes,
          });
          const result = yield* git.createWorktree({
            cwd: project.workspaceRoot,
            branch,
            newBranch,
            path: worktreePath,
          });
          createdPath = result.worktree.path;
          createdBranch = result.worktree.branch;
          createdHead = (yield* git.execute({
            operation: "WorktreeWorkspaceReactor.readHead",
            cwd: createdPath,
            args: ["rev-parse", "HEAD"],
          })).stdout.trim();
        }
      }

      if (
        !createdPath ||
        !createdBranch ||
        !createdHead ||
        !targetResolvedCommit ||
        !createdFromCommit
      ) {
        return yield* Effect.fail(new Error("Worktree provisioning returned incomplete metadata"));
      }

      stage = "setup";
      const setupScripts = project.scripts.filter((script) => script.runOnWorktreeCreate);
      for (const script of setupScripts) {
        yield* runSetupCommand(script.command, createdPath);
      }

      stage = "commit-completion";
      yield* orchestrationEngine.dispatch({
        type: "workspace.provision.complete",
        commandId: commandId("provision-complete", String(workspace.id)),
        workspaceId: workspace.id,
        operationId: operation.id,
        generation: operation.generation,
        path: createdPath,
        branch: createdBranch,
        headRef: createdHead,
        targetResolvedCommit,
        createdFromCommit,
        ...(refreshedPullRequest
          ? {
              targetRef: refreshedPullRequest.baseBranch,
              lastKnownPr: refreshedPullRequest,
            }
          : {}),
        setupStatus: setupScripts.length > 0 ? "succeeded" : "skipped",
        completedAt: new Date().toISOString(),
      });
    }).pipe(Effect.catch(fail));
  });

  const lifecycleFailure = (input: {
    workspace: OrchestrationWorktreeWorkspace;
    stage: string;
    cause: unknown;
  }) => {
    const operation = input.workspace.activeOperation;
    if (!operation) return Effect.void;
    return orchestrationEngine
      .dispatch({
        type: "workspace.operation.fail",
        commandId: commandId(`${operation.kind}-failed`, String(input.workspace.id)),
        workspaceId: input.workspace.id,
        operationId: operation.id,
        generation: operation.generation,
        kind: operation.kind,
        stage: input.stage,
        summary: errorSummary(input.cause),
        logId: null,
        failedAt: new Date().toISOString(),
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((dispatchCause) =>
          Effect.logWarning("failed to record workspace lifecycle failure", {
            workspaceId: input.workspace.id,
            operation: operation.kind,
            cause: Cause.pretty(dispatchCause),
          }),
        ),
      );
  };

  const archive = Effect.fn(function* (request: WorkspaceRequest) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const workspace = (readModel.workspaces ?? []).find(
      (candidate) => candidate.id === request.workspaceId,
    );
    const project = readModel.projects.find((candidate) => candidate.id === request.projectId);
    if (
      !workspace ||
      !project ||
      workspace.state !== "archiving" ||
      workspace.activeOperation?.kind !== "archive"
    ) {
      return;
    }
    const operation = workspace.activeOperation;
    let stage = "preflight";
    yield* Effect.gen(function* () {
      const preflight = yield* getWorkspaceLifecyclePreflight({
        readModel,
        input: { workspaceId: workspace.id, action: "archive" },
        git,
        fileSystem,
        devServerManager,
        terminalManager,
        inFlightOperationId: String(operation.id),
      });
      if (!preflight.canStart) {
        return yield* Effect.fail(
          new Error(preflight.blockers.map((blocker) => blocker.message).join(" ")),
        );
      }
      if (preflight.requiresConfirmation && operation.stage !== "intent-confirmed") {
        return yield* Effect.fail(
          new Error(preflight.warnings.map((warning) => warning.message).join(" ")),
        );
      }

      if (workspace.kind === "managed" && workspace.path) {
        stage = "remove-worktree";
        if (yield* fileSystem.exists(workspace.path)) {
          // Deliberately omit force: Git remains the final dirty-worktree safeguard.
          yield* git.removeWorktree({ cwd: project.workspaceRoot, path: workspace.path });
        }
      } else if (workspace.kind !== "external") {
        return yield* Effect.fail(
          new Error(`Workspace kind '${workspace.kind}' cannot be archived.`),
        );
      }

      stage = "commit-completion";
      yield* orchestrationEngine.dispatch({
        type: "workspace.archive.complete",
        commandId: commandId("archive-complete", String(workspace.id)),
        workspaceId: workspace.id,
        operationId: operation.id,
        generation: operation.generation,
        completedAt: new Date().toISOString(),
      });
    }).pipe(
      Effect.catch((cause) =>
        stage === "commit-completion"
          ? Effect.logWarning(
              "workspace archive completion dispatch failed; recovery remains pending",
              {
                workspaceId: workspace.id,
                cause: errorSummary(cause),
              },
            )
          : lifecycleFailure({ workspace, stage, cause }),
      ),
    );
  });

  const restoreWorkspace = Effect.fn(function* (request: WorkspaceRequest) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const workspace = (readModel.workspaces ?? []).find(
      (candidate) => candidate.id === request.workspaceId,
    );
    const project = readModel.projects.find((candidate) => candidate.id === request.projectId);
    if (
      !workspace ||
      !project ||
      workspace.state !== "provisioning" ||
      workspace.activeOperation?.kind !== "restore"
    ) {
      return;
    }
    const operation = workspace.activeOperation;
    let stage = "preflight";
    yield* Effect.gen(function* () {
      const preflight = yield* getWorkspaceLifecyclePreflight({
        readModel,
        input: { workspaceId: workspace.id, action: "restore" },
        git,
        fileSystem,
        devServerManager,
        terminalManager,
        inFlightOperationId: String(operation.id),
      });
      if (!preflight.canStart) {
        return yield* Effect.fail(
          new Error(preflight.blockers.map((blocker) => blocker.message).join(" ")),
        );
      }
      if (!workspace.path || !workspace.branch) {
        return yield* Effect.fail(new Error("Archived workspace metadata is incomplete."));
      }

      let restoredPath = workspace.path;
      let restoredBranch = workspace.branch;
      let restoredHead = workspace.headRef;
      let setupStatus: "succeeded" | "skipped" = "skipped";

      if (workspace.kind === "managed") {
        stage = "create-worktree";
        if (yield* fileSystem.exists(workspace.path)) {
          const actualBranch = (yield* git.execute({
            operation: "WorktreeWorkspaceReactor.restoreExistingBranch",
            cwd: workspace.path,
            args: ["branch", "--show-current"],
          })).stdout.trim();
          if (actualBranch !== workspace.branch) {
            return yield* Effect.fail(
              new Error(
                `The occupied workspace path uses branch '${actualBranch || "detached HEAD"}'.`,
              ),
            );
          }
        } else {
          yield* fileSystem.makeDirectory(path.dirname(workspace.path), { recursive: true });
          const result = yield* git.createWorktree({
            cwd: project.workspaceRoot,
            branch: workspace.branch,
            path: workspace.path,
          });
          restoredPath = result.worktree.path;
          restoredBranch = result.worktree.branch;
        }
        restoredHead = (yield* git.execute({
          operation: "WorktreeWorkspaceReactor.restoreHead",
          cwd: restoredPath,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim();

        stage = "setup";
        const setupScripts = project.scripts.filter((script) => script.runOnWorktreeCreate);
        for (const script of setupScripts) {
          yield* runSetupCommand(script.command, restoredPath);
        }
        setupStatus = setupScripts.length > 0 ? "succeeded" : "skipped";
      } else if (workspace.kind === "external") {
        stage = "verify-external";
        restoredHead = (yield* git.execute({
          operation: "WorktreeWorkspaceReactor.restoreExternalHead",
          cwd: restoredPath,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim();
        restoredBranch = (yield* git.execute({
          operation: "WorktreeWorkspaceReactor.restoreExternalBranch",
          cwd: restoredPath,
          args: ["branch", "--show-current"],
        })).stdout.trim();
      } else {
        return yield* Effect.fail(
          new Error(`Workspace kind '${workspace.kind}' cannot be restored.`),
        );
      }

      if (!restoredPath || !restoredBranch || !restoredHead) {
        return yield* Effect.fail(new Error("Workspace restore returned incomplete metadata."));
      }
      stage = "commit-completion";
      yield* orchestrationEngine.dispatch({
        type: "workspace.restore.complete",
        commandId: commandId("restore-complete", String(workspace.id)),
        workspaceId: workspace.id,
        operationId: operation.id,
        generation: operation.generation,
        path: restoredPath,
        branch: restoredBranch,
        headRef: restoredHead,
        setupStatus,
        completedAt: new Date().toISOString(),
      });
    }).pipe(
      Effect.catch((cause) =>
        stage === "commit-completion"
          ? Effect.logWarning(
              "workspace restore completion dispatch failed; recovery remains pending",
              {
                workspaceId: workspace.id,
                cause: errorSummary(cause),
              },
            )
          : lifecycleFailure({ workspace, stage, cause }),
      ),
    );
  });

  const processRequest = (request: WorkspaceRequest) =>
    orchestrationEngine.getReadModel().pipe(
      Effect.flatMap((readModel) => {
        const workspace = (readModel.workspaces ?? []).find(
          (candidate) => candidate.id === request.workspaceId,
        );
        switch (workspace?.activeOperation?.kind) {
          case "archive":
            return archive(request);
          case "restore":
            return restoreWorkspace(request);
          default:
            return provision(request);
        }
      }),
      Effect.ensuring(Effect.sync(() => processing.delete(String(request.workspaceId)))),
    );
  const worker = yield* makeDrainableWorker(processRequest);

  const enqueue = (request: WorkspaceRequest) => {
    const id = String(request.workspaceId);
    if (processing.has(id)) return Effect.void;
    processing.add(id);
    return worker.enqueue(request);
  };

  const start: WorktreeWorkspaceReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "workspace.created" && event.payload.kind === "managed"
          ? enqueue({
              workspaceId: event.payload.workspaceId,
              projectId: event.payload.projectId,
            })
          : event.type === "workspace.provision-requested" ||
              event.type === "workspace.archive-requested" ||
              event.type === "workspace.restore-requested"
            ? orchestrationEngine.getReadModel().pipe(
                Effect.flatMap((readModel) => {
                  const workspace = (readModel.workspaces ?? []).find(
                    (candidate) => candidate.id === event.payload.workspaceId,
                  );
                  return workspace
                    ? enqueue({ workspaceId: workspace.id, projectId: workspace.projectId })
                    : Effect.void;
                }),
              )
            : Effect.void,
      ),
    );

    yield* backfillLegacyWorkspaces;

    const snapshot = yield* orchestrationEngine.getReadModel();
    for (const workspace of snapshot.workspaces ?? []) {
      if (
        workspace.activeOperation !== null &&
        ((workspace.kind === "managed" && workspace.activeOperation.kind === "provision") ||
          workspace.activeOperation.kind === "archive" ||
          workspace.activeOperation.kind === "restore")
      ) {
        yield* enqueue({
          workspaceId: workspace.id,
          projectId: workspace.projectId,
        });
      }
    }
  });

  return { start } satisfies WorktreeWorkspaceReactorShape;
});

export const WorktreeWorkspaceReactorLive = Layer.effect(
  WorktreeWorkspaceReactor,
  makeWorktreeWorkspaceReactor,
);
