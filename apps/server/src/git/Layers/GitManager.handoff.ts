// Purpose: Thread-handoff Effects for the GitManager layer — stash/worktree orchestration,
//   rollback recovery, and the public handoffThread method that moves a thread between
//   the local checkout and a worktree.
// Layer: dependency-parameterized Effect factory; built once per GitManager via makeHandoff(deps).
// Exports: Handoff, HandoffDeps, makeHandoff.

import { randomUUID } from "node:crypto";

import { Effect, type Path } from "effect";
import { resolveWorktreeHandoffIntent } from "@t3tools/shared/worktreeHandoff";

import { GitManagerError } from "../Errors.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitManagerShape } from "../Services/GitManager.ts";
import {
  buildFailedLocalHandoffRecoveryDetail,
  buildFailedLocalTransferDetail,
  buildFailedWorktreeHandoffRecoveryDetail,
  buildFailedWorktreeTransferDetail,
  combineGitMessages,
  gitManagerError,
} from "./GitManager.commits.ts";

export interface HandoffDeps {
  readonly gitCore: GitCoreShape;
  readonly path: Path.Path;
  readonly worktreesDir: string;
}

export interface Handoff {
  readonly handoffThread: GitManagerShape["handoffThread"];
}

export function makeHandoff(deps: HandoffDeps): Handoff {
  const { gitCore, path, worktreesDir } = deps;

  const readStashRef = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.handoffThread.readStashRef",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "refs/stash"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) return null;
          const trimmed = result.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      );

  const readHeadRef = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.handoffThread.readHeadRef",
        cwd,
        args: ["rev-parse", "HEAD"],
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => {
          const trimmed = result.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      );

  const checkoutDetached = (cwd: string, ref: string) =>
    gitCore
      .execute({
        operation: "GitManager.handoffThread.checkoutDetached",
        cwd,
        args: ["checkout", "--detach", ref],
        timeoutMs: 30_000,
      })
      .pipe(Effect.asVoid);

  const buildNamedWorktreePath = (cwd: string, name: string) => {
    const repoName = path.basename(cwd);
    const sanitizedName = name.trim().replaceAll("/", "-");
    return path.join(worktreesDir, repoName, sanitizedName);
  };

  const createDetachedWorktree = (input: {
    cwd: string;
    ref: string;
    path: string | null;
    name?: string | null;
  }) =>
    Effect.gen(function* () {
      const resolvedPath =
        input.path ?? (input.name ? buildNamedWorktreePath(input.cwd, input.name) : null);
      const worktree = yield* gitCore.createDetachedWorktree({
        cwd: input.cwd,
        ref: input.ref,
        path: resolvedPath,
      });
      return worktree;
    });

  const createNamedWorktree = (input: {
    cwd: string;
    baseBranch: string;
    name: string;
    path: string | null;
  }) =>
    Effect.gen(function* () {
      const resolvedPath = input.path ?? buildNamedWorktreePath(input.cwd, input.name);
      return yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: input.baseBranch,
        newBranch: input.name,
        path: resolvedPath,
      });
    });

  const stashWorkingTree = (cwd: string, label: string) =>
    Effect.gen(function* () {
      if (!(yield* gitCore.statusDetails(cwd)).hasWorkingTreeChanges) {
        return {
          hadChanges: false,
          stashRef: null,
        };
      }
      const beforeRef = yield* readStashRef(cwd);
      yield* gitCore.execute({
        operation: "GitManager.handoffThread.stashPush",
        cwd,
        args: ["stash", "push", "--include-untracked", "-m", label],
        timeoutMs: 30_000,
      });
      const afterRef = yield* readStashRef(cwd);
      if (afterRef === beforeRef) {
        return yield* gitManagerError(
          "handoffThread",
          "Git did not create a stash entry while preparing the thread handoff.",
        );
      }
      return {
        hadChanges: true,
        stashRef: afterRef,
      };
    });

  const dropStashBySha = (cwd: string, stashSha: string) =>
    Effect.gen(function* () {
      const listResult = yield* gitCore.execute({
        operation: "GitManager.handoffThread.listStashShas",
        cwd,
        args: ["stash", "list", "--format=%H"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (listResult.code !== 0) return;
      const index = listResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .indexOf(stashSha);
      if (index < 0) return;
      yield* gitCore.execute({
        operation: "GitManager.handoffThread.stashDrop",
        cwd,
        args: ["stash", "drop", `stash@{${index}}`],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
    });

  const popStash = (cwd: string, stashRef: string | null) =>
    Effect.gen(function* () {
      if (!stashRef) {
        return {
          conflictsDetected: false,
          message: null,
        };
      }
      // `git stash pop` requires a `stash@{N}` reference, but `stashRef` here is the
      // commit SHA captured via `git rev-parse refs/stash` in `readStashRef`. Apply
      // the stash by SHA (which `git stash apply` accepts for any stash-shaped
      // commit) and then drop the matching list entry on success so callers still
      // observe pop-style semantics.
      const result = yield* gitCore
        .execute({
          operation: "GitManager.handoffThread.stashApply",
          cwd,
          args: ["stash", "apply", "--index", stashRef],
          allowNonZeroExit: true,
          timeoutMs: 30_000,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({
              code: 1,
              stdout: "",
              stderr: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      if (result.code === 0) {
        yield* dropStashBySha(cwd, stashRef).pipe(Effect.catch(() => Effect.void));
        return {
          conflictsDetected: false,
          message: null,
        };
      }
      return {
        conflictsDetected: true,
        message:
          combineGitMessages(result.stdout, result.stderr) ??
          "Git reported conflicts while applying the handed off changes.",
      };
    });

  const restoreSourceStash = (cwd: string, stashRef: string | null) =>
    popStash(cwd, stashRef).pipe(Effect.asVoid);

  const restoreStashes = (restores: ReadonlyArray<{ cwd: string; stashRef: string | null }>) =>
    Effect.forEach(restores, (entry) => restoreSourceStash(entry.cwd, entry.stashRef), {
      concurrency: 1,
      discard: true,
    });

  const resolveForegroundFallbackBranch = (cwd: string, excludedBranch: string) =>
    gitCore.listBranches({ cwd }).pipe(
      Effect.map((result) => {
        const localBranches = result.branches.filter(
          (branch) =>
            !branch.isRemote && branch.name !== excludedBranch && branch.worktreePath === null,
        );
        const defaultBranch = localBranches.find((branch) => branch.isDefault)?.name ?? null;
        if (defaultBranch) return defaultBranch;
        return localBranches[0]?.name ?? null;
      }),
    );

  const restoreLocalHandoffSource = (input: {
    cwd: string;
    originalBranch: string | null;
    originalHeadRef: string | null;
    currentBranch: string | null;
    stashRef: string | null;
  }) =>
    Effect.gen(function* () {
      let checkoutRestored = input.originalBranch === input.currentBranch;
      const recoveryNotes: string[] = [];

      if (
        input.originalBranch &&
        input.currentBranch &&
        input.originalBranch !== input.currentBranch
      ) {
        checkoutRestored = yield* Effect.scoped(
          gitCore.checkoutBranch({
            cwd: input.cwd,
            branch: input.originalBranch,
          }),
        ).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            recoveryNotes.push(
              `Local could not be returned to '${input.originalBranch}': ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return Effect.succeed(false);
          }),
        );
      } else if (!input.originalBranch && input.originalHeadRef) {
        checkoutRestored = yield* checkoutDetached(input.cwd, input.originalHeadRef).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            recoveryNotes.push(
              `Local could not be returned to its previous detached HEAD: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return Effect.succeed(false);
          }),
        );
      }

      const stashRestore = yield* popStash(input.cwd, input.stashRef);
      const stashRestored = !stashRestore.conflictsDetected;
      if (stashRestore.conflictsDetected) {
        recoveryNotes.push(
          `${stashRestore.message ?? "Git reported conflicts while restoring the original Local changes."}
The local stash entry was kept for recovery.`,
        );
      }

      return {
        checkoutRestored,
        stashRestored,
        recoveryNotes,
      };
    });

  const restoreRemovedWorktreeAfterFailedLocalCheckout = (input: {
    cwd: string;
    worktreePath: string | null;
    branch: string | null;
    ref: string | null;
    worktreeStashRef: string | null;
    localStashRef: string | null;
  }) =>
    Effect.gen(function* () {
      const recoveryNotes: string[] = [];
      let worktreeRecreated = false;
      let worktreeChangesRestored = input.worktreeStashRef === null;
      let localChangesRestored = input.localStashRef === null;

      if (input.worktreePath) {
        const recreated =
          input.branch !== null
            ? yield* gitCore
                .createWorktree({
                  cwd: input.cwd,
                  branch: input.branch,
                  path: input.worktreePath,
                })
                .pipe(Effect.catch(() => Effect.succeed(null)))
            : input.ref
              ? yield* createDetachedWorktree({
                  cwd: input.cwd,
                  ref: input.ref,
                  path: input.worktreePath,
                }).pipe(Effect.catch(() => Effect.succeed(null)))
              : null;

        if (recreated?.worktree.path) {
          worktreeRecreated = true;
          const worktreeRestore = yield* popStash(recreated.worktree.path, input.worktreeStashRef);
          worktreeChangesRestored = !worktreeRestore.conflictsDetected;
          if (worktreeRestore.conflictsDetected) {
            recoveryNotes.push(
              `${worktreeRestore.message ?? "Git reported conflicts while restoring the recovered worktree changes."}
The worktree stash entry was kept for recovery.`,
            );
          }
        } else if (input.worktreeStashRef) {
          recoveryNotes.push(
            "The thread worktree could not be recreated automatically. Its uncommitted changes were kept in the Git stash for manual recovery.",
          );
        }
      }

      const localRestore = yield* popStash(input.cwd, input.localStashRef);
      localChangesRestored = !localRestore.conflictsDetected;
      if (localRestore.conflictsDetected) {
        recoveryNotes.push(
          `${localRestore.message ?? "Git reported conflicts while restoring your previous local changes."}
The local stash entry was kept for recovery.`,
        );
      }

      return {
        worktreeRecreated,
        worktreeChangesRestored,
        localChangesRestored,
        recoveryNotes,
      };
    });

  const rollbackFailedLocalTransfer = (input: {
    cwd: string;
    originalBranch: string | null;
    originalHeadRef: string | null;
    currentBranch: string | null;
    worktreePath: string | null;
    worktreeBranch: string | null;
    worktreeRef: string | null;
    worktreeStashRef: string | null;
    localStashRef: string | null;
  }) =>
    Effect.gen(function* () {
      const worktreeRecovery = yield* restoreRemovedWorktreeAfterFailedLocalCheckout({
        cwd: input.cwd,
        worktreePath: input.worktreePath,
        branch: input.worktreeBranch,
        ref: input.worktreeRef,
        worktreeStashRef: input.worktreeStashRef,
        localStashRef: null,
      });

      const localRecovery = yield* restoreLocalHandoffSource({
        cwd: input.cwd,
        originalBranch: input.originalBranch,
        originalHeadRef: input.originalHeadRef,
        currentBranch: input.currentBranch,
        stashRef: input.localStashRef,
      });

      return {
        worktreeRecreated: worktreeRecovery.worktreeRecreated,
        worktreeChangesRestored: worktreeRecovery.worktreeChangesRestored,
        localCheckoutRestored: localRecovery.checkoutRestored,
        localChangesRestored: localRecovery.stashRestored,
        recoveryNotes: [...worktreeRecovery.recoveryNotes, ...localRecovery.recoveryNotes],
      };
    });

  const rollbackFailedWorktreeTransfer = (input: {
    cwd: string;
    worktreePath: string;
    originalBranch: string | null;
    originalHeadRef: string | null;
    currentBranch: string | null;
    stashRef: string | null;
  }) =>
    Effect.gen(function* () {
      const recoveryNotes: string[] = [];
      const worktreeRemoved = yield* gitCore
        .removeWorktree({
          cwd: input.cwd,
          path: input.worktreePath,
          force: true,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) => {
            recoveryNotes.push(
              `The newly created worktree could not be removed automatically: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return Effect.succeed(false);
          }),
        );

      const localRecovery = yield* restoreLocalHandoffSource({
        cwd: input.cwd,
        originalBranch: input.originalBranch,
        originalHeadRef: input.originalHeadRef,
        currentBranch: input.currentBranch,
        stashRef: input.stashRef,
      });

      return {
        worktreeRemoved,
        checkoutRestored: localRecovery.checkoutRestored,
        stashRestored: localRecovery.stashRestored,
        recoveryNotes: [...recoveryNotes, ...localRecovery.recoveryNotes],
      };
    });

  const handoffThread: GitManagerShape["handoffThread"] = Effect.fnUntraced(function* (input) {
    const currentLocalStatus = yield* gitCore.statusDetails(input.cwd);

    if (input.targetMode === "local") {
      if (!input.worktreePath) {
        return yield* gitManagerError(
          "handoffThread",
          "Cannot hand off to Local because this thread does not have a materialized worktree.",
        );
      }

      const worktreeHeadRef = yield* readHeadRef(input.worktreePath);
      const targetLocalBranch =
        input.currentBranch ?? input.associatedWorktreeBranch ?? input.preferredLocalBranch ?? null;
      if (!(targetLocalBranch ?? worktreeHeadRef)) {
        return yield* gitManagerError(
          "handoffThread",
          "Cannot hand off to Local because the worktree thread does not have a recoverable HEAD reference.",
        );
      }

      const associatedWorktreePath = input.associatedWorktreePath ?? input.worktreePath;
      const associatedWorktreeBranch =
        input.associatedWorktreeBranch ?? input.currentBranch ?? null;
      const associatedWorktreeRef =
        input.associatedWorktreeRef ?? worktreeHeadRef ?? associatedWorktreeBranch;
      const originalLocalBranch = currentLocalStatus.branch ?? null;
      const originalLocalHeadRef = yield* readHeadRef(input.cwd);
      let currentLocalBranchAfterPreparation = originalLocalBranch;

      const preservedLocalStash = yield* stashWorkingTree(
        input.cwd,
        `synara preserve local handoff ${randomUUID()}`,
      );
      const sourceStash = yield* stashWorkingTree(
        input.worktreePath,
        `synara handoff to local ${randomUUID()}`,
      );

      yield* gitCore
        .removeWorktree({
          cwd: input.cwd,
          path: input.worktreePath,
        })
        .pipe(
          Effect.catch((error) =>
            restoreStashes([
              { cwd: input.worktreePath!, stashRef: sourceStash.stashRef },
              { cwd: input.cwd, stashRef: preservedLocalStash.stashRef },
            ]).pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

      if (targetLocalBranch && currentLocalStatus.branch !== targetLocalBranch) {
        yield* Effect.scoped(
          gitCore.checkoutBranch({
            cwd: input.cwd,
            branch: targetLocalBranch,
          }),
        ).pipe(
          Effect.catch((error) =>
            restoreRemovedWorktreeAfterFailedLocalCheckout({
              cwd: input.cwd,
              worktreePath: associatedWorktreePath,
              branch: associatedWorktreeBranch,
              ref: associatedWorktreeRef,
              worktreeStashRef: sourceStash.stashRef,
              localStashRef: preservedLocalStash.stashRef,
            }).pipe(
              Effect.flatMap((recovery) =>
                Effect.fail(
                  new GitManagerError({
                    operation: "GitManager.handoffThread",
                    detail: buildFailedLocalHandoffRecoveryDetail(error.message, recovery),
                    cause: error,
                  }),
                ),
              ),
            ),
          ),
        );
        currentLocalBranchAfterPreparation = targetLocalBranch;
      } else if (!targetLocalBranch && worktreeHeadRef) {
        yield* checkoutDetached(input.cwd, worktreeHeadRef).pipe(
          Effect.catch((error) =>
            restoreRemovedWorktreeAfterFailedLocalCheckout({
              cwd: input.cwd,
              worktreePath: associatedWorktreePath,
              branch: associatedWorktreeBranch,
              ref: associatedWorktreeRef,
              worktreeStashRef: sourceStash.stashRef,
              localStashRef: preservedLocalStash.stashRef,
            }).pipe(
              Effect.flatMap((recovery) =>
                Effect.fail(
                  new GitManagerError({
                    operation: "GitManager.handoffThread",
                    detail: buildFailedLocalHandoffRecoveryDetail(error.message, recovery),
                    cause: error,
                  }),
                ),
              ),
            ),
          ),
        );
        currentLocalBranchAfterPreparation = null;
      }

      const threadTransfer = yield* popStash(input.cwd, sourceStash.stashRef);
      if (threadTransfer.conflictsDetected) {
        const recovery = yield* rollbackFailedLocalTransfer({
          cwd: input.cwd,
          originalBranch: originalLocalBranch,
          originalHeadRef: originalLocalHeadRef,
          currentBranch: currentLocalBranchAfterPreparation,
          worktreePath: associatedWorktreePath,
          worktreeBranch: associatedWorktreeBranch,
          worktreeRef: associatedWorktreeRef,
          worktreeStashRef: sourceStash.stashRef,
          localStashRef: preservedLocalStash.stashRef,
        });
        return yield* new GitManagerError({
          operation: "GitManager.handoffThread",
          detail: buildFailedLocalTransferDetail(
            `${
              threadTransfer.message ??
              "Git reported conflicts while applying the handed off changes."
            } The handoff was rolled back so the thread stays in its worktree.`,
            recovery,
          ),
        });
      }

      const localTransfer = yield* popStash(input.cwd, preservedLocalStash.stashRef);
      const changesTransferred = sourceStash.hadChanges || preservedLocalStash.hadChanges;
      const movedThreadChanges = sourceStash.hadChanges;
      const restoredLocalChanges = preservedLocalStash.hadChanges;
      const localTargetLabel = targetLocalBranch
        ? `main local checkout on '${targetLocalBranch}'`
        : "local checkout in detached HEAD";
      const message = localTransfer.conflictsDetected
        ? `${
            localTransfer.message ??
            "Git reported conflicts while restoring your previous local changes."
          }\nYour previous local stash entry was kept for recovery.`
        : movedThreadChanges && restoredLocalChanges
          ? `Moved the thread back to the ${localTargetLabel}, carried its uncommitted work over, and restored your previous local changes.`
          : movedThreadChanges
            ? `Moved the thread back to the ${localTargetLabel} and carried its uncommitted work over.`
            : restoredLocalChanges
              ? `Moved the thread back to the ${localTargetLabel} and restored your previous local changes.`
              : `Moved the thread back to the ${localTargetLabel}.`;

      return {
        targetMode: "local",
        branch: targetLocalBranch,
        worktreePath: null,
        associatedWorktreePath,
        associatedWorktreeBranch,
        associatedWorktreeRef,
        changesTransferred,
        conflictsDetected: localTransfer.conflictsDetected,
        message,
      };
    }

    const worktreeIntent = resolveWorktreeHandoffIntent({
      preferredNewWorktreeName: input.preferredNewWorktreeName,
      associatedWorktreePath: input.associatedWorktreePath,
      associatedWorktreeBranch: input.associatedWorktreeBranch,
      associatedWorktreeRef: input.associatedWorktreeRef,
      preferredWorktreeBaseBranch:
        input.preferredWorktreeBaseBranch ?? currentLocalStatus.branch ?? null,
      currentBranch: input.currentBranch,
    });
    if (!worktreeIntent) {
      return yield* gitManagerError(
        "handoffThread",
        "Cannot hand off to a worktree because no worktree target is available.",
      );
    }
    const targetWorktreeName =
      worktreeIntent.kind === "create-new" ? worktreeIntent.worktreeName : null;
    const targetAssociatedWorktreePath =
      worktreeIntent.kind === "reuse-associated" ? worktreeIntent.associatedWorktreePath : null;
    const targetAssociatedWorktreeBranch =
      worktreeIntent.kind === "reuse-associated" ? worktreeIntent.associatedWorktreeBranch : null;
    const targetAssociatedWorktreeRef =
      worktreeIntent.kind === "reuse-associated" ? worktreeIntent.associatedWorktreeRef : null;
    const targetBaseBranch = worktreeIntent.baseBranch;
    if (!targetBaseBranch && !targetAssociatedWorktreeBranch && !targetAssociatedWorktreeRef) {
      return yield* gitManagerError(
        "handoffThread",
        "Select a base branch before handing off this thread to a worktree.",
      );
    }

    const sourceStash = yield* stashWorkingTree(
      input.cwd,
      `synara handoff to worktree ${randomUUID()}`,
    );
    const sourceBranch = currentLocalStatus.branch ?? input.currentBranch ?? null;
    const sourceHeadRef = yield* readHeadRef(input.cwd);
    let foregroundBranchAfterHandoff = currentLocalStatus.branch;

    if (sourceBranch && sourceBranch === targetAssociatedWorktreeBranch) {
      const fallbackLocalBranch = yield* resolveForegroundFallbackBranch(input.cwd, sourceBranch);
      if (!fallbackLocalBranch) {
        if (!sourceHeadRef) {
          yield* restoreSourceStash(input.cwd, sourceStash.stashRef);
          return yield* gitManagerError(
            "handoffThread",
            `Cannot hand off '${targetAssociatedWorktreeBranch}' to a worktree because there is no recoverable local HEAD reference available.`,
          );
        }
        yield* checkoutDetached(input.cwd, sourceHeadRef).pipe(
          Effect.catch((error) =>
            restoreSourceStash(input.cwd, sourceStash.stashRef).pipe(
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        foregroundBranchAfterHandoff = null;
      } else {
        yield* Effect.scoped(
          gitCore.checkoutBranch({
            cwd: input.cwd,
            branch: fallbackLocalBranch,
          }),
        ).pipe(
          Effect.catch((error) =>
            restoreSourceStash(input.cwd, sourceStash.stashRef).pipe(
              Effect.flatMap(() => Effect.fail(error)),
            ),
          ),
        );
        foregroundBranchAfterHandoff = fallbackLocalBranch;
      }
    }

    const worktree = yield* Effect.gen(function* () {
      if (targetAssociatedWorktreeRef && !targetAssociatedWorktreeBranch) {
        return yield* createDetachedWorktree({
          cwd: input.cwd,
          ref: targetAssociatedWorktreeRef,
          path: targetAssociatedWorktreePath,
        });
      }
      if (targetWorktreeName) {
        if (!targetBaseBranch) {
          return yield* gitManagerError(
            "handoffThread",
            "Select a base branch before creating a new worktree.",
          );
        }
        return yield* createNamedWorktree({
          cwd: input.cwd,
          baseBranch: targetBaseBranch,
          name: targetWorktreeName,
          path: null,
        });
      }
      if (targetAssociatedWorktreeBranch) {
        if (
          (yield* gitCore.listLocalBranchNames(input.cwd)).includes(targetAssociatedWorktreeBranch)
        ) {
          return yield* gitCore.createWorktree({
            cwd: input.cwd,
            branch: targetAssociatedWorktreeBranch,
            path: targetAssociatedWorktreePath,
          });
        }
        if (!targetBaseBranch) {
          return yield* createDetachedWorktree({
            cwd: input.cwd,
            ref: targetAssociatedWorktreeBranch,
            path: targetAssociatedWorktreePath,
          });
        }
        return yield* gitCore.createWorktree({
          cwd: input.cwd,
          branch: targetBaseBranch ?? targetAssociatedWorktreeBranch,
          newBranch: targetAssociatedWorktreeBranch,
          path: targetAssociatedWorktreePath,
        });
      }
      if (!targetBaseBranch) {
        return yield* createDetachedWorktree({
          cwd: input.cwd,
          ref: targetAssociatedWorktreeRef!,
          path: targetAssociatedWorktreePath,
        });
      }
      return yield* createDetachedWorktree({
        cwd: input.cwd,
        ref: targetBaseBranch,
        path: targetAssociatedWorktreePath,
        ...(targetWorktreeName ? { name: targetWorktreeName } : {}),
      });
    }).pipe(
      Effect.catch((error) =>
        restoreLocalHandoffSource({
          cwd: input.cwd,
          originalBranch: sourceBranch,
          originalHeadRef: sourceHeadRef,
          currentBranch: foregroundBranchAfterHandoff,
          stashRef: sourceStash.stashRef,
        }).pipe(
          Effect.flatMap((recovery) =>
            Effect.fail(
              new GitManagerError({
                operation: "GitManager.handoffThread",
                detail: buildFailedWorktreeHandoffRecoveryDetail(error.message, recovery),
                cause: error,
              }),
            ),
          ),
        ),
      ),
    );

    const transfer = yield* popStash(worktree.worktree.path, sourceStash.stashRef);
    if (transfer.conflictsDetected) {
      const recovery = yield* rollbackFailedWorktreeTransfer({
        cwd: input.cwd,
        worktreePath: worktree.worktree.path,
        originalBranch: sourceBranch,
        originalHeadRef: sourceHeadRef,
        currentBranch: foregroundBranchAfterHandoff,
        stashRef: sourceStash.stashRef,
      });
      return yield* new GitManagerError({
        operation: "GitManager.handoffThread",
        detail: buildFailedWorktreeTransferDetail(
          `${
            transfer.message ?? "Git reported conflicts while applying the handed off changes."
          } The stash entry was kept for recovery.`,
          recovery,
        ),
      });
    }

    const materializedWorktreeStatus = yield* gitCore.statusDetails(worktree.worktree.path);
    const materializedWorktreeRef =
      (yield* readHeadRef(worktree.worktree.path)) ??
      ("ref" in worktree.worktree ? worktree.worktree.ref : worktree.worktree.branch);
    const materializedWorktreeBranch = materializedWorktreeStatus.branch ?? null;
    if (materializedWorktreeBranch) {
      // Publishing is best-effort: handoff should still succeed for local-only repositories.
      yield* gitCore
        .publishBranch({ cwd: worktree.worktree.path, branch: materializedWorktreeBranch })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("GitManager.handoffThread could not publish worktree branch", {
              cwd: worktree.worktree.path,
              branch: materializedWorktreeBranch,
              reason: error.message,
            }),
          ),
        );
    }
    const changesTransferred = sourceStash.hadChanges;
    const handoffSummary =
      foregroundBranchAfterHandoff && foregroundBranchAfterHandoff !== sourceBranch
        ? `The thread moved into its worktree and Local returned to '${foregroundBranchAfterHandoff}'.`
        : foregroundBranchAfterHandoff === null && sourceBranch === targetAssociatedWorktreeBranch
          ? "The thread moved into its worktree and Local returned to a detached HEAD."
          : "The thread moved into its worktree.";
    const message = changesTransferred
      ? `${handoffSummary} Uncommitted local changes were carried over.`
      : handoffSummary;

    return {
      targetMode: "worktree",
      branch: materializedWorktreeBranch,
      worktreePath: worktree.worktree.path,
      associatedWorktreePath: worktree.worktree.path,
      associatedWorktreeBranch: materializedWorktreeBranch,
      associatedWorktreeRef: materializedWorktreeRef,
      changesTransferred,
      conflictsDetected: false,
      message,
    };
  });

  return { handoffThread };
}
