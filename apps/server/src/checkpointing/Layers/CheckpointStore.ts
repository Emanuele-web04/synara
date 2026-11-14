/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import {
  Cause,
  Deferred,
  Effect,
  Encoding,
  Exit,
  Layer,
  FileSystem,
  Option,
  Path,
  Semaphore,
} from "effect";

import { CheckpointInvariantError, type CheckpointStoreError } from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@synara/contracts";
import { CHECKPOINT_REFS_PREFIX } from "../Utils.ts";
import {
  type CheckpointCommitMetadata,
  chunkArgumentGroups,
  formatCheckpointHeadTrailer,
  parseCheckpointCommit,
  parseNameOnlyPaths,
  parseRawDiff,
} from "../historyIntegration.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
// Bounds the walk over commits created during a diffed range and the history
// tips checked against it; anything beyond stays visible as an edit.
const HISTORY_INTEGRATION_MAX_COMMITS = 1_000;
const HISTORY_INTEGRATION_MAX_TIPS = 8;
const CHECKPOINT_METADATA_CACHE_MAX_ENTRIES = 512;

// Individual git commands are already bounded by GitCore's default timeout;
// this aggregate cap exists to unstick the shared in-flight capture slot if a
// step without its own bound (e.g. temp-dir filesystem work) hangs. It exceeds
// the worst per-command-capped chain, so it never truncates a capture the
// per-command timeouts would allow.
const CHECKPOINT_CAPTURE_TIMEOUT_MS = 180_000;

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  const captureLock = yield* Semaphore.make(1);
  const inFlightCaptures = new Map<string, Deferred.Deferred<void, CheckpointStoreError>>();

  // Normalize the cwd so captures for the same repo reached via differently
  // written paths (trailing slash, relative segments) share one in-flight slot.
  const captureKey = (input: { readonly cwd: string; readonly checkpointRef: CheckpointRef }) =>
    `${path.resolve(input.cwd)}\0${input.checkpointRef}`;

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const seedCheckpointIndex = (cwd: string, tempIndexPath: string) =>
    Effect.gen(function* () {
      const indexPathResult = yield* git.execute({
        operation: "CheckpointStore.resolveWorkingIndex",
        cwd,
        args: ["rev-parse", "--git-path", "index"],
        allowNonZeroExit: true,
      });
      const indexPathRaw = indexPathResult.stdout.trim();
      if (indexPathResult.code !== 0 || indexPathRaw.length === 0) {
        return null;
      }

      const indexPath = path.isAbsolute(indexPathRaw)
        ? indexPathRaw
        : path.resolve(cwd, indexPathRaw);
      const indexExists = yield* fs.exists(indexPath).pipe(Effect.orElseSucceed(() => false));
      if (!indexExists) {
        return null;
      }

      // Preserve Git's stat cache in the throwaway index. Starting every
      // checkpoint from `read-tree HEAD` discards it, forcing `git add -A` to
      // rescan and re-hash the whole worktree before every user turn.
      const indexInfo = yield* fs.stat(indexPath);
      yield* fs.copyFile(indexPath, tempIndexPath);
      return indexInfo;
    });

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const captureCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.captureCheckpoint";

      // Checked inside the single-flight owner (see captureCheckpoint) so the
      // existence probe and the capture cannot interleave with another capture
      // for the same (cwd, checkpointRef).
      if (input.skipIfExists) {
        const existingCommit = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
        if (existingCommit !== null) {
          return;
        }
      }

      yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "synara-fs-checkpoint-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const commitEnv: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
              GIT_AUTHOR_NAME: "Synara",
              GIT_AUTHOR_EMAIL: "synara@users.noreply.github.com",
              GIT_COMMITTER_NAME: "Synara",
              GIT_COMMITTER_EMAIL: "synara@users.noreply.github.com",
            };

            const workingIndexInfo = yield* seedCheckpointIndex(input.cwd, tempIndexPath);
            if (workingIndexInfo === null && (yield* hasHeadCommit(input.cwd))) {
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["read-tree", "HEAD"],
                env: commitEnv,
              });
            }
            if (workingIndexInfo !== null) {
              // A copied index can describe a rapid same-size rewrite as clean
              // when its cached stat tuple still matches. Really-refresh makes
              // Git verify those racily-clean entries and leaves changed paths
              // for the following add to hash, without discarding the cache for
              // the rest of a large workspace.
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["update-index", "--really-refresh"],
                env: commitEnv,
                allowNonZeroExit: true,
              });

              // Copying or refreshing the temporary index advances its file
              // timestamp. Git uses that timestamp to decide whether an entry
              // whose cached stat tuple still matches is "racily clean" and
              // needs hashing. Restore the working index's original timestamp
              // so rapid same-size rewrites remain newer than (or equal to) the
              // index snapshot and `git add` verifies their contents.
              if (workingIndexInfo.mtime !== undefined) {
                yield* fs.utimes(
                  tempIndexPath,
                  workingIndexInfo.atime ?? workingIndexInfo.mtime,
                  workingIndexInfo.mtime,
                );
              }
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["add", "-A", "--", "."],
              env: commitEnv,
            });

            const writeTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["write-tree"],
              env: commitEnv,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty tree oid.",
              });
            }

            const message = `Synara checkpoint ref=${input.checkpointRef}`;
            // Recorded so diffs can leave out history this turn only checked out.
            const headCommit = yield* resolveHeadCommit(input.cwd);
            const commitTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: [
                "commit-tree",
                treeOid,
                "-m",
                message,
                ...(headCommit ? ["-m", formatCheckpointHeadTrailer(headCommit)] : []),
              ],
              env: commitEnv,
            });
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git commit-tree",
                cwd: input.cwd,
                detail: "git commit-tree returned an empty commit oid.",
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["update-ref", input.checkpointRef, commitOid],
            });
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(
              new CheckpointInvariantError({
                operation: "CheckpointStore.captureCheckpoint",
                detail: "Failed to capture checkpoint.",
                cause: error,
              }),
            ),
        }),
      );
    });

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const key = captureKey(input);
      const registration = yield* captureLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = inFlightCaptures.get(key);
          if (existing) {
            return { owner: false as const, deferred: existing };
          }
          const deferred = yield* Deferred.make<void, CheckpointStoreError>();
          inFlightCaptures.set(key, deferred);
          return { owner: true as const, deferred };
        }),
      );

      if (!registration.owner) {
        return yield* Deferred.await(registration.deferred);
      }

      // Let the git capture remain interruptible, but always notify waiters
      // and clear the shared in-flight slot before this owner fiber exits.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            restore(
              captureCheckpointOnce(input).pipe(
                Effect.timeoutOption(CHECKPOINT_CAPTURE_TIMEOUT_MS),
                Effect.flatMap((completed) =>
                  Option.isSome(completed)
                    ? Effect.void
                    : Effect.fail(
                        new CheckpointInvariantError({
                          operation: "CheckpointStore.captureCheckpoint",
                          detail: `Checkpoint capture timed out after ${CHECKPOINT_CAPTURE_TIMEOUT_MS}ms.`,
                        }),
                      ),
                ),
              ),
            ),
          );
          // Waiters joined an in-flight capture they do not control; replaying the
          // owner's raw interrupt cause would make callers treat it as their own
          // fiber being interrupted. Surface a typed error instead.
          const waiterExit =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Exit.fail(
                  new CheckpointInvariantError({
                    operation: "CheckpointStore.captureCheckpoint",
                    detail: "Checkpoint capture was interrupted before completion.",
                  }),
                )
              : exit;
          yield* Deferred.done(registration.deferred, waiterExit);
          yield* captureLock.withPermits(1)(Effect.sync(() => inFlightCaptures.delete(key)));
          if (Exit.isFailure(exit)) {
            return yield* Effect.failCause(exit.cause);
          }
        }),
      );
    });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const copyCheckpointRef: CheckpointStoreShape["copyCheckpointRef"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.copyCheckpointRef";
      const commitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["update-ref", input.toCheckpointRef, commitOid],
      });
      return true;
    });

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    });

  // Commit objects are immutable, so metadata is cached by object id.
  const checkpointMetadataCache = new Map<string, CheckpointCommitMetadata>();
  const readCheckpointMetadata = (
    cwd: string,
    commitOid: string,
  ): Effect.Effect<CheckpointCommitMetadata, GitCommandError> => {
    const cached = checkpointMetadataCache.get(commitOid);
    if (cached) return Effect.succeed(cached);
    return git
      .execute({
        operation: "CheckpointStore.readCheckpointMetadata",
        cwd,
        args: ["cat-file", "commit", commitOid],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) return { capturedAtSeconds: null, head: null };
          const metadata = parseCheckpointCommit(result.stdout);
          checkpointMetadataCache.set(commitOid, metadata);
          if (checkpointMetadataCache.size > CHECKPOINT_METADATA_CACHE_MAX_ENTRIES) {
            const oldest = checkpointMetadataCache.keys().next().value;
            if (oldest !== undefined) checkpointMetadataCache.delete(oldest);
          }
          return metadata;
        }),
      );
  };

  const listChangedPaths = (cwd: string, from: string, to: string) =>
    git
      .execute({
        operation: "CheckpointStore.changedPaths",
        cwd,
        args: ["diff", "--name-only", "-z", "--no-renames", from, to],
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.map((result) => parseNameOnlyPaths(result.stdout)));

  /**
   * Commits that entered HEAD between two checkpoints without being created
   * after the first one: the incoming side of a merge or rebase, or the target
   * of a pull, checkout or reset.
   */
  const resolveIntegratedHistoryTips = (input: {
    readonly cwd: string;
    readonly fromHead: string;
    readonly toHead: string;
    readonly fromCapturedAtSeconds: number;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.resolveIntegratedHistoryTips";
      const created = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "rev-list",
          "--parents",
          `--max-age=${input.fromCapturedAtSeconds}`,
          `--max-count=${HISTORY_INTEGRATION_MAX_COMMITS + 1}`,
          input.toHead,
          `^${input.fromHead}`,
        ],
      });
      const createdCommits = new Map<string, string[]>();
      for (const line of created.stdout.split("\n")) {
        const [commit, ...parents] = line.trim().split(/\s+/);
        if (commit) createdCommits.set(commit, parents);
      }
      // A truncated walk could mistake an omitted new commit for incoming history.
      if (createdCommits.size > HISTORY_INTEGRATION_MAX_COMMITS) return [];
      // Nothing was committed in range, so the new HEAD is existing history.
      if (createdCommits.size === 0) return [input.toHead];

      const candidates = new Set<string>();
      for (const parents of createdCommits.values()) {
        for (const parent of parents) {
          if (parent !== input.fromHead && !createdCommits.has(parent)) candidates.add(parent);
        }
      }
      const tips: string[] = [];
      for (const candidate of candidates) {
        if (tips.length >= HISTORY_INTEGRATION_MAX_TIPS) break;
        // A parent already behind the starting HEAD (amend, reset then commit)
        // is not incoming history; its differences stay visible as edits.
        const ancestor = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["merge-base", "--is-ancestor", candidate, input.fromHead],
          allowNonZeroExit: true,
        });
        if (ancestor.code === 1) tips.push(candidate);
      }
      return tips;
    });

  // A merged branch must have changed a path itself before its contents
  // can explain a change in the final tree. For a checkout, compare directly
  // with the starting HEAD because the branch switch replaces that tree.
  const listIntegratedPaths = (input: {
    readonly cwd: string;
    readonly fromHead: string;
    readonly toHead: string;
    readonly tip: string;
    readonly isDescendant: boolean;
  }) =>
    Effect.gen(function* () {
      const { cwd, fromHead, toHead, tip, isDescendant } = input;
      let baseline = fromHead;
      if (isDescendant && tip !== toHead) {
        const bases = (yield* git.execute({
          operation: "CheckpointStore.resolveIntegratedMergeBase",
          cwd,
          args: ["merge-base", "--all", fromHead, tip],
        })).stdout.trim();
        if (bases.length === 0 || bases.includes("\n")) return new Set<string>();
        baseline = bases;
      }
      const [incomingPaths, finalDifferences] = yield* Effect.all([
        listChangedPaths(cwd, baseline, tip),
        tip === toHead ? Effect.succeed(new Set<string>()) : listChangedPaths(cwd, tip, toHead),
      ]);
      for (const path of finalDifferences) incomingPaths.delete(path);
      return incomingPaths;
    });

  /**
   * The diff target that shows only what changed on top of history moves.
   *
   * A path is left out only when it was clean against HEAD at both checkpoints
   * and its final content equals an integrated history tip, so local edits,
   * conflict resolutions and discarded uncommitted work stay visible. Legacy
   * checkpoints without a recorded HEAD, or any lookup failure, keep the full
   * diff.
   */
  const resolveAuthoredDiffTarget = (input: {
    readonly cwd: string;
    readonly fromCommitOid: string;
    readonly toCommitOid: string;
  }): Effect.Effect<string> =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.resolveAuthoredDiffTarget";
      const [from, to] = yield* Effect.all(
        [
          readCheckpointMetadata(input.cwd, input.fromCommitOid),
          readCheckpointMetadata(input.cwd, input.toCommitOid),
        ],
        { concurrency: "unbounded" },
      );
      const fromHead = from.head;
      const toHead = to.head;
      if (!fromHead || !toHead || fromHead === toHead || from.capturedAtSeconds === null) {
        return input.toCommitOid;
      }

      const tips = yield* resolveIntegratedHistoryTips({
        cwd: input.cwd,
        fromHead,
        toHead,
        fromCapturedAtSeconds: from.capturedAtSeconds,
      });
      if (tips.length === 0) return input.toCommitOid;

      const changes = parseRawDiff(
        (yield* git.execute({
          operation,
          cwd: input.cwd,
          args: [
            "diff",
            "--raw",
            "-z",
            "--no-renames",
            "--no-abbrev",
            input.fromCommitOid,
            input.toCommitOid,
          ],
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        })).stdout,
      );
      if (changes.length === 0) return input.toCommitOid;

      const ancestry = tips.includes(toHead)
        ? undefined
        : yield* git.execute({
            operation,
            cwd: input.cwd,
            args: ["merge-base", "--is-ancestor", fromHead, toHead],
            allowNonZeroExit: true,
          });
      if (ancestry && ancestry.code !== 0 && ancestry.code !== 1) return input.toCommitOid;

      const [dirtyAtStart, dirtyAtEnd, ...integratedPaths] = yield* Effect.all(
        [
          listChangedPaths(input.cwd, fromHead, input.fromCommitOid),
          listChangedPaths(input.cwd, toHead, input.toCommitOid),
          ...tips.map((tip) =>
            listIntegratedPaths({
              cwd: input.cwd,
              fromHead,
              toHead,
              tip,
              isDescendant: ancestry?.code === 0,
            }),
          ),
        ],
        { concurrency: 4 },
      );
      const integrated = changes.filter(
        (change) =>
          !dirtyAtStart!.has(change.path) &&
          !dirtyAtEnd!.has(change.path) &&
          integratedPaths.some((paths) => paths.has(change.path)),
      );
      if (integrated.length === 0) return input.toCommitOid;
      if (integrated.length === changes.length) return input.fromCommitOid;

      const topLevel = (yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["rev-parse", "--show-toplevel"],
      })).stdout.trim();
      return yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "synara-checkpoint-authored-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
            yield* git.execute({
              operation,
              cwd: topLevel,
              args: ["read-tree", input.toCommitOid],
              env,
            });
            // Remove incoming entries before restoring their predecessors.
            // A path can switch between a file and a directory.
            const restored = integrated.filter((change) => change.status !== "A");
            const removed = integrated.filter((change) => change.status === "A");
            for (const chunk of chunkArgumentGroups(removed.map((change) => [change.path]))) {
              yield* git.execute({
                operation,
                cwd: topLevel,
                args: ["update-index", "--force-remove", "--", ...chunk],
                env,
              });
            }
            for (const chunk of chunkArgumentGroups(
              restored.map((change) => [
                "--cacheinfo",
                change.sourceMode,
                change.sourceObject,
                change.path,
              ]),
            )) {
              yield* git.execute({
                operation,
                cwd: topLevel,
                args: ["update-index", "--add", ...chunk],
                env,
              });
            }
            const tree = (yield* git.execute({
              operation,
              cwd: topLevel,
              args: ["write-tree"],
              env,
            })).stdout.trim();
            return tree.length > 0 ? tree : input.toCommitOid;
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("checkpoint diff keeps integrated history", {
          cwd: input.cwd,
          detail: error.message,
        }).pipe(Effect.as(input.toCommitOid)),
      ),
    );

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpoints";

      if (input.providerPatch !== undefined) {
        const baseline = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
        if (
          !baseline ||
          Buffer.byteLength(input.providerPatch, "utf8") > CHECKPOINT_DIFF_MAX_OUTPUT_BYTES
        ) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Provider patch baseline or size is unavailable.",
          });
        }
        if (input.providerPatch.length === 0) return "";
        // Reconstruct the immutable provider revision in a fresh index. Never
        // seed from today's index/files or ask apply to merge a mismatched base.
        return yield* Effect.acquireUseRelease(
          fs.makeTempDirectory({ prefix: "synara-provider-patch-" }),
          (tempDir) =>
            Effect.gen(function* () {
              const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
              const patchPath = path.join(tempDir, "provider.patch");
              yield* fs.writeFileString(patchPath, input.providerPatch!);
              yield* git.execute({ operation, cwd: input.cwd, args: ["read-tree", baseline], env });
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["apply", "--cached", "--whitespace=nowarn", "--", patchPath],
                env,
              });
              const result = yield* git.execute({
                operation,
                cwd: input.cwd,
                args: [
                  "diff",
                  "--cached",
                  "--patch",
                  "--minimal",
                  "--no-color",
                  "--no-ext-diff",
                  "--no-textconv",
                  "--src-prefix=a/",
                  "--dst-prefix=b/",
                  ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
                  baseline,
                ],
                env,
                maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
              });
              return result.stdout;
            }),
          (tempDir) => fs.remove(tempDir, { recursive: true }).pipe(Effect.orDie),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof GitCommandError || cause instanceof CheckpointInvariantError
              ? cause
              : new CheckpointInvariantError({
                  operation,
                  detail: "Could not prepare a private provider patch index.",
                  cause,
                }),
          ),
        );
      }

      let [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          fromCommitOid,
          yield* resolveAuthoredDiffTarget({ cwd: input.cwd, fromCommitOid, toCommitOid }),
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });

      return result.stdout;
    });

  // Rolls the working tree back to `treeOid` for the provided paths without
  // touching the repository index: paths absent from the tree did not exist
  // before the aborted apply, so they are deleted instead of restored.
  const restoreWorktreePathsFromTree = (input: {
    readonly cwd: string;
    readonly treeOid: string;
    readonly paths: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreWorktreePathsFromTree";
      if (input.paths.length === 0) {
        return;
      }

      const trackedResult = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["ls-tree", "-r", "--name-only", "-z", input.treeOid, "--", ...input.paths],
        allowNonZeroExit: true,
      });
      const trackedPaths = trackedResult.stdout.split("\0").filter((entry) => entry.length > 0);
      if (trackedPaths.length > 0) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["restore", "--source", input.treeOid, "--worktree", "--", ...trackedPaths],
        });
      }

      const trackedPathSet = new Set(trackedPaths);
      yield* Effect.forEach(
        input.paths.filter((entry) => !trackedPathSet.has(entry)),
        (relativePath) => fs.remove(path.join(input.cwd, relativePath), { force: true }),
        { discard: true },
      );
    });

  // Fallback for undo when the working tree drifted after the checkpoint: a
  // plain `git apply --reverse` is all-or-nothing, so any unrelated edit in a
  // touched hunk aborts the whole undo.
  //
  // `git apply --3way` implies `--index` and therefore refuses to run while the
  // working tree differs from the index. Point it at a throwaway index that
  // mirrors the current working tree so the merge can run; the repository index
  // stays untouched and the caller's `git reset` remains its only writer.
  const applyReverseWithThreeWayMerge = (input: {
    readonly cwd: string;
    readonly tempDir: string;
    readonly patchPath: string;
    readonly affectedPaths: ReadonlyArray<string>;
    readonly strictApplyStderr: string;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reverseCheckpointDiff";
      const mergeIndexEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: path.join(input.tempDir, `undo-index-${randomUUID()}`),
      };

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["read-tree", "HEAD"],
          env: mergeIndexEnv,
        });
      }
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["add", "-A", "--", "."],
        env: mergeIndexEnv,
      });
      // Snapshot of the pre-attempt working tree, used to undo a conflicted
      // 3-way apply (which writes conflict markers before failing).
      const preAttemptTreeResult = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["write-tree"],
        env: mergeIndexEnv,
      });
      const preAttemptTreeOid = preAttemptTreeResult.stdout.trim();

      const applied = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["apply", "--reverse", "--3way", "--whitespace=nowarn", "--", input.patchPath],
        env: mergeIndexEnv,
        allowNonZeroExit: true,
      });
      if (applied.code === 0) {
        return;
      }

      if (preAttemptTreeOid.length > 0) {
        yield* restoreWorktreePathsFromTree({
          cwd: input.cwd,
          treeOid: preAttemptTreeOid,
          paths: input.affectedPaths,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to roll back a conflicted checkpoint undo", {
              cwd: input.cwd,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }

      return yield* new GitCommandError({
        operation,
        command: "git apply --reverse --3way",
        cwd: input.cwd,
        detail: [
          "Undo could not be applied because the workspace changed since this checkpoint.",
          input.strictApplyStderr.trim(),
          applied.stderr.trim(),
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      });
    });

  const reverseCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reverseCheckpointDiff";
      const [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid || !toCommitOid) {
        return false;
      }
      // Undo reverses the same changes the turn diff shows, never checked-out history.
      const targetOid = yield* resolveAuthoredDiffTarget({
        cwd: input.cwd,
        fromCommitOid,
        toCommitOid,
      });

      const diff = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--binary",
          "--full-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          fromCommitOid,
          targetOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      if (diff.stdout.length === 0) {
        return true;
      }

      const changedPaths = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--name-only", "--no-renames", "-z", fromCommitOid, targetOid],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      const affectedPaths = changedPaths.stdout.split("\0").filter((entry) => entry.length > 0);

      return yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "synara-checkpoint-undo-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const patchPath = path.join(tempDir, "turn.patch");
            yield* fs.writeFileString(patchPath, diff.stdout);
            const strictApply = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["apply", "--reverse", "--whitespace=nowarn", "--", patchPath],
              allowNonZeroExit: true,
            });
            if (strictApply.code !== 0) {
              yield* applyReverseWithThreeWayMerge({
                cwd: input.cwd,
                tempDir,
                patchPath,
                affectedPaths,
                strictApplyStderr: strictApply.stderr,
              });
            }
            if (affectedPaths.length > 0) {
              const resetExit = yield* Effect.exit(
                git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["reset", "--quiet", fromCommitOid, "--", ...affectedPaths],
                }),
              );
              if (Exit.isFailure(resetExit)) {
                yield* git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["apply", "--whitespace=nowarn", "--", patchPath],
                });
                return yield* Effect.failCause(resetExit.cause);
              }
            }
            return true;
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation,
              detail: "Failed to prepare the checkpoint patch for undo.",
              cause: error,
            }),
          ),
        ),
      );
    });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.deleteCheckpointRefs";

      const checkpointRefs = new Set(input.checkpointRefs);
      if (input.liveThreadId !== undefined) {
        // Projection rows identify the published revision only. Enumeration at
        // thread purge also releases captures interrupted before publication.
        const prefix = `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(input.liveThreadId)}/turn-live/`;
        const liveRefs = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["for-each-ref", "--format=%(refname)", prefix],
        });
        for (const line of liveRefs.stdout.split("\n")) {
          const ref = line.trim();
          if (ref.startsWith(prefix)) checkpointRefs.add(CheckpointRef.makeUnsafe(ref));
        }
      }

      // Ref deletion writes contend on packed-refs.lock, so a concurrent delete
      // can lose the lock race. `allowNonZeroExit` keeps one loser from
      // abandoning the rest of the batch, but the exit codes must still be
      // inspected: silently discarding them made every caller's cleanup error
      // handling unreachable. Deleting an already-absent ref exits 0, so the
      // "missing refs are tolerated" contract is unaffected.
      const results = yield* Effect.forEach(checkpointRefs, (checkpointRef) =>
        git
          .execute({
            operation,
            cwd: input.cwd,
            args: ["update-ref", "-d", checkpointRef],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => ({ checkpointRef, result }))),
      );

      const failures = results.filter((entry) => entry.result.code !== 0);
      if (failures.length === 0) {
        return;
      }

      return yield* new GitCommandError({
        operation,
        command: "git update-ref -d",
        cwd: input.cwd,
        detail: `Failed to delete ${failures.length} of ${results.length} checkpoint ref(s): ${failures
          .map(
            (entry) =>
              `${entry.checkpointRef} (${entry.result.stderr.trim() || `exit code ${entry.result.code}`})`,
          )
          .join("; ")}`,
      });
    });

  return {
    isGitRepository,
    captureCheckpoint,
    copyCheckpointRef,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    reverseCheckpointDiff,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
