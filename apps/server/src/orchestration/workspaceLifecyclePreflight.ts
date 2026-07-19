import { resolve } from "node:path";

import type {
  OrchestrationReadModel,
  WorkspaceLifecyclePreflightInput,
  WorkspaceLifecyclePreflightIssue,
  WorkspaceLifecyclePreflightResult,
} from "@synara/contracts";
import { Effect, FileSystem } from "effect";

import type { DevServerManagerShape } from "../devServerManager";
import type { GitCoreShape } from "../git/Services/GitCore";
import type { TerminalManagerShape } from "../terminal/Services/Manager";

interface WorkspaceLifecyclePreflightDependencies {
  readonly readModel: OrchestrationReadModel;
  readonly input: WorkspaceLifecyclePreflightInput;
  readonly git: GitCoreShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly devServerManager: DevServerManagerShape;
  readonly terminalManager: TerminalManagerShape;
  readonly inFlightOperationId?: string;
}

const issue = (
  code: WorkspaceLifecyclePreflightIssue["code"],
  message: string,
): WorkspaceLifecyclePreflightIssue => ({ code, message });

const activeAgentSession = (thread: OrchestrationReadModel["threads"][number]) =>
  thread.latestTurn?.state === "running" ||
  thread.session?.status === "starting" ||
  thread.session?.status === "running";

const hasDeletedUpstream = (
  git: GitCoreShape,
  cwd: string,
  status: {
    readonly branch: string | null;
    readonly hasUpstream: boolean;
    readonly upstreamBranch: string | null;
  },
) =>
  !status.hasUpstream || !status.branch || !status.upstreamBranch
    ? Effect.succeed(false)
    : Effect.gen(function* () {
        const branch = status.branch as string;
        const upstreamBranch = status.upstreamBranch as string;
        const remote = yield* git.execute({
          operation: "WorktreeWorkspaceLifecyclePreflight.upstreamRemote",
          cwd,
          args: ["config", "--get", `branch.${branch}.remote`],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
        });
        const remoteName = remote.code === 0 ? remote.stdout.trim() : "";
        if (!remoteName || remoteName === ".") return false;

        const remoteBranch = upstreamBranch.replace(/^refs\/heads\//, "");
        const published = yield* git.execute({
          operation: "WorktreeWorkspaceLifecyclePreflight.upstreamPublication",
          cwd,
          args: ["ls-remote", "--exit-code", "--heads", remoteName, `refs/heads/${remoteBranch}`],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxOutputBytes: 4_096,
          truncateOutput: true,
        });
        return published.code === 2 || (published.code === 0 && published.stdout.trim() === "");
      }).pipe(Effect.catch(() => Effect.succeed(false)));

export const getWorkspaceLifecyclePreflight = Effect.fn(function* (
  dependencies: WorkspaceLifecyclePreflightDependencies,
) {
  const { fileSystem, git, input, readModel } = dependencies;
  const workspace = (readModel.workspaces ?? []).find(
    (candidate) => candidate.id === input.workspaceId && candidate.deletedAt === null,
  );
  if (!workspace) {
    const blockers = [issue("workspace-not-found", "This workspace no longer exists.")];
    return {
      workspaceId: input.workspaceId,
      action: input.action,
      lifecycleGeneration: 0,
      canStart: false,
      requiresConfirmation: false,
      blockers,
      warnings: [],
    } satisfies WorkspaceLifecyclePreflightResult;
  }

  const blockers: WorkspaceLifecyclePreflightIssue[] = [];
  const warnings: WorkspaceLifecyclePreflightIssue[] = [];
  if (workspace.kind === "repository-root") {
    blockers.push(
      issue("repository-root", "The repository root is permanent and cannot be archived."),
    );
  }

  const expectedState = input.action === "archive" ? "ready" : "archived";
  const inFlightState = input.action === "archive" ? "archiving" : "provisioning";
  const matchingInFlightOperation =
    dependencies.inFlightOperationId !== undefined &&
    workspace.state === inFlightState &&
    workspace.activeOperation?.id === dependencies.inFlightOperationId &&
    workspace.activeOperation.kind === input.action;
  if (workspace.state !== expectedState && !matchingInFlightOperation) {
    blockers.push(
      issue(
        "invalid-state",
        `This workspace cannot ${input.action} while its state is ${workspace.state}.`,
      ),
    );
  }
  if (workspace.activeOperation !== null && !matchingInFlightOperation) {
    blockers.push(
      issue(
        "operation-active",
        `Wait for the current ${workspace.activeOperation.kind} operation to finish.`,
      ),
    );
  }

  const workspaceThreads = readModel.threads.filter(
    (thread) => thread.workspaceId === workspace.id && thread.deletedAt === null,
  );
  if (input.action === "archive" && workspaceThreads.some(activeAgentSession)) {
    blockers.push(
      issue("agent-active", "Stop the active agent turn before archiving this workspace."),
    );
  }

  const threadIds = new Set(workspaceThreads.map((thread) => String(thread.id)));
  const hasTerminal =
    input.action === "archive" && dependencies.terminalManager.hasRunningSessionForThreadIds
      ? yield* dependencies.terminalManager.hasRunningSessionForThreadIds(threadIds)
      : false;
  if (hasTerminal) {
    blockers.push(issue("terminal-active", "Close the workspace terminals before archiving."));
  }

  const devServers = yield* dependencies.devServerManager.list;
  if (
    input.action === "archive" &&
    devServers.servers.some(
      (server) => server.projectId === workspace.projectId && server.workspaceId === workspace.id,
    )
  ) {
    blockers.push(issue("dev-server-active", "Stop this workspace's dev server before archiving."));
  }

  const project = readModel.projects.find((candidate) => candidate.id === workspace.projectId);
  if (!project) {
    blockers.push(issue("repository-mismatch", "The workspace project is unavailable."));
  } else if (input.action === "archive" && workspace.kind === "managed") {
    if (!workspace.path) {
      blockers.push(issue("path-unavailable", "The managed workspace path is unavailable."));
    } else if (yield* fileSystem.exists(workspace.path)) {
      const status = yield* git.statusDetails(workspace.path).pipe(Effect.option);
      if (status._tag === "None") {
        blockers.push(
          issue(
            "git-status-unavailable",
            "Git status could not be verified, so Synara will not remove this worktree.",
          ),
        );
      } else {
        const conflicts = yield* git
          .execute({
            operation: "WorktreeWorkspaceLifecyclePreflight.conflicts",
            cwd: workspace.path,
            args: ["diff", "--name-only", "--diff-filter=U", "-z"],
            maxOutputBytes: 64 * 1024,
            truncateOutput: true,
          })
          .pipe(Effect.option);
        if (conflicts._tag === "None") {
          blockers.push(
            issue(
              "git-status-unavailable",
              "Merge-conflict state could not be verified, so Synara will not remove this worktree.",
            ),
          );
        } else if (conflicts.value.stdout.length > 0) {
          blockers.push(
            issue(
              "merge-conflicts",
              "Resolve the merge conflicts before archiving this workspace.",
            ),
          );
        }
        if (status.value.hasWorkingTreeChanges) {
          blockers.push(
            issue(
              "working-tree-dirty",
              "Commit, stash, or discard the workspace changes before archiving.",
            ),
          );
        } else if (
          !status.value.hasUpstream ||
          status.value.publication?.state === "stale_upstream" ||
          (yield* hasDeletedUpstream(git, workspace.path, status.value))
        ) {
          warnings.push(
            issue(
              "local-only-commits",
              "This branch is local only. Archiving keeps the local branch, but its commits are not on GitHub.",
            ),
          );
        } else if (status.value.aheadCount > 0) {
          warnings.push(
            issue(
              "unpushed-commits",
              `This branch has ${status.value.aheadCount} unpushed commit${status.value.aheadCount === 1 ? "" : "s"}. Archiving keeps the local branch.`,
            ),
          );
        }
      }
    }
  } else if (input.action === "restore") {
    if (!workspace.path) {
      blockers.push(issue("path-unavailable", "The archived workspace path is unavailable."));
    } else if (workspace.kind === "managed") {
      if (!workspace.branch) {
        blockers.push(issue("branch-unavailable", "The archived workspace branch is unavailable."));
      } else {
        const branch = yield* git.execute({
          operation: "WorktreeWorkspaceLifecyclePreflight.branch",
          cwd: project.workspaceRoot,
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${workspace.branch}`],
          allowNonZeroExit: true,
        });
        if (branch.code !== 0) {
          blockers.push(
            issue(
              "branch-unavailable",
              `The retained local branch '${workspace.branch}' no longer exists.`,
            ),
          );
        }
      }
      if (yield* fileSystem.exists(workspace.path)) {
        const registeredWorktrees = yield* git
          .execute({
            operation: "WorktreeWorkspaceLifecyclePreflight.registeredWorktrees",
            cwd: project.workspaceRoot,
            args: ["worktree", "list", "--porcelain"],
          })
          .pipe(Effect.option);
        const registeredAtExpectedPath =
          registeredWorktrees._tag === "Some" &&
          registeredWorktrees.value.stdout
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .some((line) => resolve(line.slice("worktree ".length)) === resolve(workspace.path!));
        const existingRoot = yield* git
          .execute({
            operation: "WorktreeWorkspaceLifecyclePreflight.existingPath",
            cwd: workspace.path,
            args: ["rev-parse", "--show-toplevel"],
            allowNonZeroExit: true,
          })
          .pipe(Effect.option);
        const canonicalExpected = yield* fileSystem
          .realPath(workspace.path)
          .pipe(Effect.catch(() => Effect.succeed(workspace.path!)));
        const canonicalActual =
          existingRoot._tag === "Some" && existingRoot.value.code === 0
            ? yield* fileSystem
                .realPath(existingRoot.value.stdout.trim())
                .pipe(Effect.catch(() => Effect.succeed(existingRoot.value.stdout.trim())))
            : null;
        if (!registeredAtExpectedPath || canonicalActual !== canonicalExpected) {
          blockers.push(
            issue(
              "path-occupied",
              "Another file or directory occupies the archived workspace path.",
            ),
          );
        }
      }
    } else if (workspace.kind === "external") {
      if (!(yield* fileSystem.exists(workspace.path))) {
        blockers.push(issue("path-unavailable", "The external workspace folder no longer exists."));
      } else {
        const commonDirs = yield* Effect.all(
          [workspace.path, project.workspaceRoot].map((cwd) =>
            git
              .execute({
                operation: "WorktreeWorkspaceLifecyclePreflight.repositoryIdentity",
                cwd,
                args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                allowNonZeroExit: true,
              })
              .pipe(Effect.option),
          ),
        );
        const values = yield* Effect.all(
          commonDirs.map((result) =>
            result._tag === "Some" && result.value.code === 0
              ? fileSystem
                  .realPath(result.value.stdout.trim())
                  .pipe(Effect.catch(() => Effect.succeed(result.value.stdout.trim())))
              : Effect.succeed(null),
          ),
        );
        if (!values[0] || values[0] !== values[1]) {
          blockers.push(
            issue(
              "repository-mismatch",
              "The external folder no longer belongs to this project's repository.",
            ),
          );
        }
      }
    }
  }

  return {
    workspaceId: workspace.id,
    action: input.action,
    lifecycleGeneration: workspace.lifecycleGeneration,
    canStart: blockers.length === 0,
    requiresConfirmation: blockers.length === 0 && warnings.length > 0,
    blockers,
    warnings,
  } satisfies WorkspaceLifecyclePreflightResult;
});
