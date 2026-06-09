// Purpose: GitManager Effect layer — stacked git actions, PR lifecycle, worktree handoff.
// Layer: Layers (Effect.gen factory bound to GitCore/GitHubCli/TextGeneration services).
// Exports: makeGitManager, GitManagerLive. Pure helpers/types live in the sibling
//   GitManager.types.ts, GitManager.pullRequests.ts, and GitManager.commits.ts modules.

import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Path } from "effect";
import type {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitStackedAction,
  ProviderStartOptions,
} from "@t3tools/contracts";
import { resolveAutoFeatureBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import {
  GitManager,
  type GitActionProgressReporter,
  type GitManagerShape,
  type GitRunStackedActionOptions,
} from "../Services/GitManager.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import {
  COMMIT_TIMEOUT_MS,
  type CommitAndBranchSuggestion,
  type FeatureBranchStepOptions,
  type GitActionProgressPayload,
} from "./GitManager.types.ts";
import {
  isPullRequestAlreadyExistsError,
  normalizePullRequestReference,
  resolvePullRequestWorktreeLocalBranchName,
  toPullRequestHeadRemoteInfo,
  toResolvedPullRequest,
  toStatusPr,
} from "./GitManager.pullRequests.ts";
import { makePrResolution } from "./GitManager.prResolution.ts";
import { makeHandoff } from "./GitManager.handoff.ts";
import {
  canonicalizeExistingPath,
  createFallbackCommitSuggestion,
  formatCommitMessage,
  gitManagerError,
  isCommitAction,
  limitContext,
  parseCustomCommitMessage,
  prioritizeRemoteNames,
  sanitizeCommitMessage,
  sanitizeProgressText,
} from "./GitManager.commits.ts";

export const makeGitManager = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;

  const createProgressEmitter = (
    input: { cwd: string; action: GitStackedAction },
    options?: GitRunStackedActionOptions,
  ) => {
    const actionId = options?.actionId ?? randomUUID();
    const reporter = options?.progressReporter;

    const emit = (event: GitActionProgressPayload) =>
      reporter
        ? reporter.publish({
            actionId,
            cwd: input.cwd,
            action: input.action,
            ...event,
          } as GitActionProgressEvent)
        : Effect.void;

    return {
      actionId,
      emit,
    };
  };

  const {
    configurePullRequestHeadUpstream,
    materializePullRequestHeadBranch,
    resolveBranchHeadContext,
    findOpenPr,
    findLatestPr,
    resolveAlreadyExistingPullRequest,
    resolveBaseBranch,
  } = makePrResolution({ gitCore, gitHubCli });

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir } = yield* ServerConfig;

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const { handoffThread } = makeHandoff({ gitCore, path, worktreesDir });

  const resolveCommitAndBranchSuggestion = (input: {
    cwd: string;
    branch: string | null;
    commitMessage?: string;
    codexHomePath?: string;
    providerOptions?: ProviderStartOptions;
    /** When true, also produce a semantic feature branch name. */
    includeBranch?: boolean;
    filePaths?: readonly string[];
    model?: string;
  }) =>
    Effect.gen(function* () {
      const context = yield* gitCore.prepareCommitContext(input.cwd, input.filePaths);
      if (!context) {
        return null;
      }

      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          ...(input.model ? { model: input.model } : {}),
        })
        .pipe(
          Effect.map((result) => sanitizeCommitMessage(result)),
          Effect.catchTag("TextGenerationError", (error) =>
            Effect.logWarning(
              `GitManager.resolveCommitAndBranchSuggestion: falling back to heuristic commit message in ${input.cwd}: ${error.message}`,
            ).pipe(
              Effect.as(
                createFallbackCommitSuggestion({
                  stagedSummary: context.stagedSummary,
                  ...(input.includeBranch ? { includeBranch: true } : {}),
                }),
              ),
            ),
          ),
        );

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      };
    });

  const runCommitStep = (
    cwd: string,
    action: "commit" | "commit_push" | "commit_push_pr",
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
    codexHomePath?: string,
    providerOptions?: ProviderStartOptions,
    model?: string,
    progressReporter?: GitActionProgressReporter,
    actionId?: string,
  ) =>
    Effect.gen(function* () {
      const emit = (event: GitActionProgressPayload) =>
        progressReporter && actionId
          ? progressReporter.publish({
              actionId,
              cwd,
              action,
              ...event,
            } as GitActionProgressEvent)
          : Effect.void;

      let suggestion: CommitAndBranchSuggestion | null | undefined = preResolvedSuggestion;
      if (!suggestion) {
        const needsGeneration = !commitMessage?.trim();
        if (needsGeneration) {
          yield* emit({
            kind: "phase_started",
            phase: "commit",
            label: "Generating commit message...",
          });
        }
        suggestion = yield* resolveCommitAndBranchSuggestion({
          cwd,
          branch,
          ...(commitMessage ? { commitMessage } : {}),
          ...(filePaths ? { filePaths } : {}),
          ...(codexHomePath ? { codexHomePath } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          ...(model ? { model } : {}),
        });
      }
      if (!suggestion) {
        return { status: "skipped_no_changes" as const };
      }

      yield* emit({
        kind: "phase_started",
        phase: "commit",
        label: "Committing...",
      });

      let currentHookName: string | null = null;
      const commitProgress =
        progressReporter && actionId
          ? {
              onOutputLine: ({ stream, text }: { stream: "stdout" | "stderr"; text: string }) => {
                const sanitized = sanitizeProgressText(text);
                if (!sanitized) {
                  return Effect.void;
                }
                return emit({
                  kind: "hook_output",
                  hookName: currentHookName,
                  stream,
                  text: sanitized,
                });
              },
              onHookStarted: (hookName: string) => {
                currentHookName = hookName;
                return emit({
                  kind: "hook_started",
                  hookName,
                });
              },
              onHookFinished: ({
                hookName,
                exitCode,
                durationMs,
              }: {
                hookName: string;
                exitCode: number | null;
                durationMs: number | null;
              }) => {
                if (currentHookName === hookName) {
                  currentHookName = null;
                }
                return emit({
                  kind: "hook_finished",
                  hookName,
                  exitCode,
                  durationMs,
                });
              },
            }
          : null;
      const { commitSha } = yield* gitCore.commit(cwd, suggestion.subject, suggestion.body, {
        timeoutMs: COMMIT_TIMEOUT_MS,
        ...(commitProgress ? { progress: commitProgress } : {}),
      });
      if (currentHookName !== null) {
        yield* emit({
          kind: "hook_finished",
          hookName: currentHookName,
          exitCode: 0,
          durationMs: null,
        });
        currentHookName = null;
      }
      return {
        status: "created" as const,
        commitSha,
        subject: suggestion.subject,
      };
    });

  const runPrStep = (
    cwd: string,
    fallbackBranch: string | null,
    codexHomePath?: string,
    providerOptions?: ProviderStartOptions,
    model?: string,
  ) =>
    Effect.gen(function* () {
      const details = yield* gitCore.statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* gitManagerError(
          "runPrStep",
          "Cannot create a pull request from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* gitManagerError(
          "runPrStep",
          "Current branch has not been pushed. Push before creating a PR.",
        );
      }

      const headContext = yield* resolveBranchHeadContext(cwd, {
        branch,
        upstreamRef: details.upstreamRef,
      });

      const existing = yield* findOpenPr(cwd, headContext);
      if (existing) {
        return {
          status: "opened_existing" as const,
          url: existing.url,
          number: existing.number,
          baseBranch: existing.baseRefName,
          headBranch: existing.headRefName,
          title: existing.title,
        };
      }

      const baseBranch = yield* resolveBaseBranch(cwd, branch, details.upstreamRef, headContext);
      if (!headContext.isCrossRepository && baseBranch === headContext.headBranch) {
        return yield* gitManagerError(
          "runPrStep",
          `Cannot create a pull request from '${headContext.headBranch}' into itself. Create or switch to a feature branch and retry.`,
        );
      }
      const rangeContext = yield* gitCore.readRangeContext(cwd, baseBranch);

      const generated = yield* textGeneration.generatePrContent({
        cwd,
        baseBranch,
        headBranch: headContext.headBranch,
        commitSummary: limitContext(rangeContext.commitSummary, 20_000),
        diffSummary: limitContext(rangeContext.diffSummary, 20_000),
        diffPatch: limitContext(rangeContext.diffPatch, 60_000),
        ...(codexHomePath ? { codexHomePath } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        ...(model ? { model } : {}),
      });

      const bodyFile = path.join(tempDir, `t3code-pr-body-${process.pid}-${randomUUID()}.md`);
      yield* fileSystem
        .writeFileString(bodyFile, generated.body)
        .pipe(
          Effect.mapError((cause) =>
            gitManagerError("runPrStep", "Failed to write pull request body temp file.", cause),
          ),
        );
      const existingAfterCreateConflict = yield* gitHubCli
        .createPullRequest({
          cwd,
          baseBranch,
          headSelector: headContext.preferredHeadSelector,
          title: generated.title,
          bodyFile,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) => {
            if (!isPullRequestAlreadyExistsError(error)) {
              return Effect.fail(error);
            }
            return resolveAlreadyExistingPullRequest(cwd, error, headContext);
          }),
          Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))),
        );
      if (existingAfterCreateConflict) {
        return {
          status: "opened_existing" as const,
          url: existingAfterCreateConflict.url,
          number: existingAfterCreateConflict.number,
          baseBranch: existingAfterCreateConflict.baseRefName,
          headBranch: existingAfterCreateConflict.headRefName,
          title: existingAfterCreateConflict.title,
        };
      }

      const created = yield* findOpenPr(cwd, headContext);
      if (!created) {
        return {
          status: "created" as const,
          baseBranch,
          headBranch: headContext.headBranch,
          title: generated.title,
        };
      }

      return {
        status: "created" as const,
        url: created.url,
        number: created.number,
        baseBranch: created.baseRefName,
        headBranch: created.headRefName,
        title: created.title,
      };
    });

  const status: GitManagerShape["status"] = Effect.fnUntraced(function* (input) {
    const details = yield* gitCore.statusDetails(input.cwd);

    const pr =
      details.branch !== null
        ? yield* findLatestPr(input.cwd, {
            branch: details.branch,
            upstreamRef: details.upstreamRef,
          }).pipe(
            Effect.map((latest) => (latest ? toStatusPr(latest) : null)),
            Effect.catch(() => Effect.succeed(null)),
          )
        : null;

    return {
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      upstreamBranch: details.upstreamBranch,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      pr,
    };
  });

  const readWorkingTreeDiff: GitManagerShape["readWorkingTreeDiff"] = Effect.fnUntraced(
    function* (input) {
      switch (input.scope) {
        case "branch":
          return yield* gitCore.readBranchPatch(input.cwd);
        case "staged":
          return yield* gitCore.readStagedPatch(input.cwd);
        case "unstaged":
          return yield* gitCore.readUnstagedPatch(input.cwd);
        case "workingTree":
        default:
          return yield* gitCore.readWorkingTreePatch(input.cwd);
      }
    },
  );

  // Keep diff summaries read-only by summarizing the patch already selected in the UI.
  const summarizeDiff: GitManagerShape["summarizeDiff"] = Effect.fnUntraced(function* (input) {
    const patch = input.patch.trim();
    if (patch.length === 0) {
      return yield* gitManagerError("summarizeDiff", "Cannot summarize an empty diff.");
    }

    const generated = yield* textGeneration.generateDiffSummary({
      cwd: input.cwd,
      patch,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      ...(input.textGenerationModel ? { model: input.textGenerationModel } : {}),
    });

    return {
      summary: generated.summary,
    };
  });

  const resolvePullRequest: GitManagerShape["resolvePullRequest"] = Effect.fnUntraced(
    function* (input) {
      const pullRequest = yield* gitHubCli
        .getPullRequest({
          cwd: input.cwd,
          reference: normalizePullRequestReference(input.reference),
        })
        .pipe(Effect.map((resolved) => toResolvedPullRequest(resolved)));

      return { pullRequest };
    },
  );

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fnUntraced(
    function* (input) {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = canonicalizeExistingPath(input.cwd);
      const pullRequestSummary = yield* gitHubCli.getPullRequest({
        cwd: input.cwd,
        reference: normalizedReference,
      });
      const pullRequest = toResolvedPullRequest(pullRequestSummary);

      if (input.mode === "local") {
        yield* gitHubCli.checkoutPullRequest({
          cwd: input.cwd,
          reference: normalizedReference,
          force: true,
        });
        const details = yield* gitCore.statusDetails(input.cwd);
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
        return {
          pullRequest,
          branch: details.branch ?? pullRequest.headBranch,
          worktreePath: null,
        };
      }

      const ensureExistingWorktreeUpstream = (worktreePath: string) =>
        Effect.gen(function* () {
          const details = yield* gitCore.statusDetails(worktreePath);
          yield* configurePullRequestHeadUpstream(
            worktreePath,
            {
              ...pullRequest,
              ...toPullRequestHeadRemoteInfo(pullRequestSummary),
            },
            details.branch ?? pullRequest.headBranch,
          );
        });

      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      } as const;
      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      const findLocalHeadBranch = (cwd: string) =>
        gitCore.listBranches({ cwd }).pipe(
          Effect.map((result) => {
            const localBranch = result.branches.find(
              (branch) => !branch.isRemote && branch.name === localPullRequestBranch,
            );
            if (localBranch) {
              return localBranch;
            }
            if (localPullRequestBranch === pullRequest.headBranch) {
              return null;
            }
            return (
              result.branches.find(
                (branch) =>
                  !branch.isRemote &&
                  branch.name === pullRequest.headBranch &&
                  branch.worktreePath !== null &&
                  canonicalizeExistingPath(branch.worktreePath) !== rootWorktreePath,
              ) ?? null
            );
          }),
        );

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath)
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchBeforeFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchBeforeFetch.worktreePath,
        };
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchAfterFetch.worktreePath)
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchAfterFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchAfterFetch.worktreePath,
        };
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      const worktree = yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: localPullRequestBranch,
        path: null,
      });
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
      };
    },
  );


  const runFeatureBranchStep = (
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
    codexHomePath?: string,
    providerOptions?: ProviderStartOptions,
    model?: string,
    options?: FeatureBranchStepOptions,
  ) =>
    Effect.gen(function* () {
      const suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(codexHomePath ? { codexHomePath } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        includeBranch: true,
        ...(model ? { model } : {}),
      });
      if (!suggestion && !options?.allowCommittedHead) {
        return yield* gitManagerError(
          "runFeatureBranchStep",
          "Cannot create a feature branch because there are no changes to commit.",
        );
      }

      const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
      const committedHeadBranchBase = yield* Effect.gen(function* () {
        if (suggestion) {
          return suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
        }
        const latestCommitSubject = yield* gitCore
          .execute({
            operation: "GitManager.runFeatureBranchStep.readHeadSubject",
            cwd,
            args: ["log", "-1", "--pretty=%s"],
          })
          .pipe(Effect.map((result) => result.stdout.trim().split(/\r?\n/g)[0]?.trim() ?? ""));
        if (latestCommitSubject.length > 0) {
          return latestCommitSubject;
        }
        return branch ? `${branch}-update` : undefined;
      });
      const resolvedBranch = resolveAutoFeatureBranchName(
        existingBranchNames,
        committedHeadBranchBase,
      );

      yield* gitCore.createBranch({ cwd, branch: resolvedBranch });
      yield* Effect.scoped(gitCore.checkoutBranch({ cwd, branch: resolvedBranch }));
      if (options?.restoreOriginalBranchRef && branch) {
        // Move the original branch back to its trusted remote/upstream ref so
        // "create feature branch and continue" actually removes the commits
        // from the source branch instead of leaving both branches pointing at them.
        yield* gitCore.execute({
          operation: "GitManager.runFeatureBranchStep.restoreOriginalBranch",
          cwd,
          args: ["branch", "--force", branch, options.restoreOriginalBranchRef],
        });
      }

      return {
        branchStep: { status: "created" as const, name: resolvedBranch },
        resolvedCommitMessage: suggestion?.commitMessage,
        resolvedCommitSuggestion: suggestion ?? undefined,
      };
    });

  const resolveCommittedHeadRestoreRef = (
    cwd: string,
    details: { branch: string | null; upstreamRef: string | null },
  ) =>
    Effect.gen(function* () {
      if (!details.branch) {
        return null;
      }
      if (details.upstreamRef) {
        return details.upstreamRef;
      }

      const remoteNames = yield* gitCore
        .execute({
          operation: "GitManager.resolveCommittedHeadRestoreRef.listRemotes",
          cwd,
          args: ["remote"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(Effect.map((result) => prioritizeRemoteNames(result.stdout.split(/\r?\n/g))));
      if (remoteNames.length > 1) {
        return yield* gitManagerError(
          "resolveCommittedHeadRestoreRef",
          `Cannot move committed work to a feature branch because '${details.branch}' has no upstream and this repository has multiple remotes. Push the branch first or configure its upstream before retrying.`,
        );
      }

      for (const remoteName of remoteNames) {
        const remoteRef = `${remoteName}/${details.branch}`;
        const remoteExists = yield* gitCore
          .execute({
            operation: "GitManager.resolveCommittedHeadRestoreRef.remoteExists",
            cwd,
            args: ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteRef}`],
            allowNonZeroExit: true,
            timeoutMs: 5_000,
          })
          .pipe(Effect.map((result) => result.code === 0));
        if (!remoteExists) {
          continue;
        }

        yield* gitCore.execute({
          operation: "GitManager.resolveCommittedHeadRestoreRef.refreshRemoteBranch",
          cwd,
          args: [
            "fetch",
            "--quiet",
            "--no-tags",
            remoteName,
            `+refs/heads/${details.branch}:refs/remotes/${remoteRef}`,
          ],
          timeoutMs: 10_000,
        });
        return remoteRef;
      }

      return yield* gitManagerError(
        "resolveCommittedHeadRestoreRef",
        `Cannot move committed work to a feature branch because '${details.branch}' has no upstream or matching remote branch to restore.`,
      );
    });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fnUntraced(
    function* (input, options) {
      const progress = createProgressEmitter(input, options);
      let currentPhase: GitActionProgressPhase | null = null;

      const runAction = Effect.gen(function* () {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        const wantsCommit = isCommitAction(input.action);
        const wantsPush =
          input.action === "push" ||
          input.action === "commit_push" ||
          input.action === "commit_push_pr" ||
          (input.action === "create_pr" &&
            (input.featureBranch || !initialStatus.hasUpstream || initialStatus.aheadCount > 0));
        const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";
        const phases: GitActionProgressPhase[] = [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
          ...(wantsPr ? (["pr"] as const) : []),
        ];

        yield* progress.emit({
          kind: "action_started",
          phases,
        });

        if (input.action === "push" && initialStatus.hasWorkingTreeChanges) {
          return yield* gitManagerError(
            "runStackedAction",
            "Commit or stash local changes before pushing.",
          );
        }
        if (input.action === "create_pr" && initialStatus.hasWorkingTreeChanges) {
          return yield* gitManagerError(
            "runStackedAction",
            "Commit local changes before creating a PR.",
          );
        }
        if (!input.featureBranch && wantsPush && !initialStatus.branch) {
          return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
        }
        if (!input.featureBranch && wantsPr && !initialStatus.branch) {
          return yield* gitManagerError(
            "runStackedAction",
            "Cannot create a pull request from detached HEAD.",
          );
        }
        const committedHeadRestoreRef =
          input.featureBranch && !wantsCommit
            ? yield* resolveCommittedHeadRestoreRef(input.cwd, {
                branch: initialStatus.branch,
                upstreamRef: initialStatus.upstreamRef,
              })
            : null;

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

        if (input.featureBranch) {
          currentPhase = "branch";
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature branch...",
          });
          const result = yield* runFeatureBranchStep(
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
            input.codexHomePath,
            input.providerOptions,
            input.textGenerationModel,
            {
              allowCommittedHead: !wantsCommit,
              restoreOriginalBranchRef: committedHeadRestoreRef,
            },
          );
          branchStep = result.branchStep;
          commitMessageForStep = result.resolvedCommitMessage;
          preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;
        const commitAction = isCommitAction(input.action) ? input.action : null;
        const commit = commitAction
          ? yield* Effect.gen(function* () {
              currentPhase = "commit";
              return yield* runCommitStep(
                input.cwd,
                commitAction,
                currentBranch,
                commitMessageForStep,
                preResolvedCommitSuggestion,
                input.filePaths,
                input.codexHomePath,
                input.providerOptions,
                input.textGenerationModel,
                options?.progressReporter,
                progress.actionId,
              );
            })
          : { status: "skipped_not_requested" as const };

        const push = wantsPush
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              })
              .pipe(
                Effect.flatMap(() =>
                  Effect.gen(function* () {
                    currentPhase = "push";
                    return yield* gitCore.pushCurrentBranch(input.cwd, currentBranch);
                  }),
                ),
              )
          : { status: "skipped_not_requested" as const };

        const pr = wantsPr
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "pr",
                label: "Creating PR...",
              })
              .pipe(
                Effect.flatMap(() =>
                  Effect.gen(function* () {
                    currentPhase = "pr";
                    return yield* runPrStep(
                      input.cwd,
                      currentBranch,
                      input.codexHomePath,
                      input.providerOptions,
                      input.textGenerationModel,
                    );
                  }),
                ),
              )
          : { status: "skipped_not_requested" as const };

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
        };
        yield* progress.emit({
          kind: "action_finished",
          result,
        });
        return result;
      });

      return yield* runAction.pipe(
        Effect.catch((error) =>
          progress
            .emit({
              kind: "action_failed",
              phase: currentPhase,
              message: error.message,
            })
            .pipe(Effect.flatMap(() => Effect.fail(error))),
        ),
      );
    },
  );

  return {
    status,
    readWorkingTreeDiff,
    summarizeDiff,
    resolvePullRequest,
    preparePullRequestThread,
    handoffThread,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager);
