// FILE: libraryGit.ts
// Purpose: Git operations for the per-group Library — one in-flight queue per
//          project serializes init/mutate/push so parallel uploads cannot
//          interleave add/commit. Commits are authored as the Synara Library
//          identity; remote pushes are best-effort and never block a write.
// Layer: Server domain helper
// Exports: withLibraryQueue, initLibraryRepo, commitLibraryChange,
//          libraryHistory, restoreLibraryEntry, pushLibraryIfConfigured,
//          readLibraryPushStatus

import type { LibraryCommit } from "@synara/contracts";
import { Effect, Semaphore } from "effect";

import type { GitCommandError } from "../git/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";

const LIBRARY_AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "Synara Library",
  GIT_AUTHOR_EMAIL: "library@synara.local",
  GIT_COMMITTER_NAME: "Synara Library",
  GIT_COMMITTER_EMAIL: "library@synara.local",
} satisfies NodeJS.ProcessEnv;

const runGit = (git: GitCoreShape, operation: string, cwd: string, args: readonly string[]) =>
  git.execute({
    operation,
    cwd,
    args: [...args],
    env: LIBRARY_AUTHOR_ENV,
  });

const runGitStdout = (git: GitCoreShape, operation: string, cwd: string, args: readonly string[]) =>
  Effect.map(runGit(git, operation, cwd, args), (result) => result.stdout.trim());

// One keyed semaphore per library root owner. Mirrors the lock map in
// agentGateway/creationCoordinator.ts: locks are dropped once no queued or
// in-flight operation references them.
const lockIndex = Effect.runSync(Semaphore.make(1));
const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

export function withLibraryQueue<A, E, R>(
  projectId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    lockIndex.withPermits(1)(
      Effect.gen(function* () {
        const existing = locks.get(projectId);
        if (existing) {
          existing.users += 1;
          return existing;
        }
        const entry = { lock: yield* Semaphore.make(1), users: 1 };
        locks.set(projectId, entry);
        return entry;
      }),
    ),
    (entry) => entry.lock.withPermits(1)(effect),
    (entry) =>
      lockIndex.withPermits(1)(
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0 && locks.get(projectId) === entry) locks.delete(projectId);
        }),
      ),
  );
}

export function initLibraryRepo(git: GitCoreShape, root: string) {
  return runGit(git, "library.init", root, ["init", "-b", "main"]).pipe(Effect.asVoid);
}

// Stages the whole tree and commits. Returns the new HEAD; when nothing changed
// the commit is skipped and the current HEAD is returned so callers always get
// a stable sha.
export function commitLibraryChange(
  git: GitCoreShape,
  root: string,
  message: string,
): Effect.Effect<{ readonly commitSha: string }, GitCommandError> {
  return Effect.gen(function* () {
    yield* runGit(git, "library.stage", root, ["add", "-A"]);
    const stagedNames = yield* runGitStdout(git, "library.stagedNames", root, [
      "diff",
      "--cached",
      "--name-only",
    ]);
    if (stagedNames.length === 0) {
      return {
        commitSha: yield* runGitStdout(git, "library.head", root, ["rev-parse", "HEAD"]),
      };
    }
    yield* runGit(git, "library.commit", root, ["commit", "-m", message]);
    return {
      commitSha: yield* runGitStdout(git, "library.head", root, ["rev-parse", "HEAD"]),
    };
  });
}

const LOG_FIELD_SEPARATOR = "\x1f";

// `relativePath` is the already-normalized library-relative path; when omitted
// the whole-repo history is returned.
export function libraryHistory(
  git: GitCoreShape,
  root: string,
  relativePath?: string | undefined,
): Effect.Effect<readonly LibraryCommit[], GitCommandError> {
  const args = [
    "log",
    `--format=%H${LOG_FIELD_SEPARATOR}%an${LOG_FIELD_SEPARATOR}%aI${LOG_FIELD_SEPARATOR}%s`,
    ...(relativePath ? ["--follow", "--", relativePath] : []),
  ];
  return Effect.map(runGit(git, "library.history", root, args), (result) => {
    const commits: LibraryCommit[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [sha, author, at, ...messageParts] = line.split(LOG_FIELD_SEPARATOR);
      if (!sha || !author || !at) continue;
      commits.push({
        sha,
        author,
        at,
        message: messageParts.join(LOG_FIELD_SEPARATOR) || "(no message)",
      });
    }
    return commits;
  });
}

// Checks out the path at `sha`, then commits the restoration so the timeline
// keeps an explicit record of the rollback.
export function restoreLibraryEntry(
  git: GitCoreShape,
  root: string,
  relativePath: string,
  sha: string,
): Effect.Effect<{ readonly commitSha: string }, GitCommandError> {
  return Effect.gen(function* () {
    yield* runGit(git, "library.restoreCheckout", root, ["checkout", sha, "--", relativePath]);
    return yield* commitLibraryChange(git, root, `Restore ${relativePath} from ${sha.slice(0, 7)}`);
  });
}

interface LibraryPushRecord {
  readonly at: string;
  readonly error: string | null;
}

// Process-local record of the last push attempt per project. Restarting the
// server clears it; the remote itself is the durable record.
const pushStatusByProject = new Map<string, LibraryPushRecord>();

export function readLibraryPushStatus(projectId: string): {
  readonly lastPushAt: string | null;
  readonly lastPushError: string | null;
} {
  const record = pushStatusByProject.get(projectId);
  return {
    lastPushAt: record?.at ?? null,
    lastPushError: record?.error ?? null,
  };
}

const REMOTE_NAME = "synara-library";

// Pushes to `libraryRemoteUrl` when `libraryPushOnChange` is set. The remote URL
// is managed under a fixed name so edits to the URL re-point the same remote.
// Failures are recorded and swallowed: a down remote must not break writes.
export function pushLibraryIfConfigured(input: {
  readonly git: GitCoreShape;
  readonly root: string;
  readonly projectId: string;
  readonly libraryRemoteUrl?: string | undefined;
  readonly libraryPushOnChange?: boolean | undefined;
}): Effect.Effect<void, never> {
  const { git, root, projectId, libraryRemoteUrl, libraryPushOnChange } = input;
  return Effect.gen(function* () {
    if (!libraryRemoteUrl || libraryPushOnChange !== true) return;
    const record = (error: string | null) =>
      pushStatusByProject.set(projectId, { at: new Date().toISOString(), error });
    yield* Effect.gen(function* () {
      const remotes = yield* runGitStdout(git, "library.remoteList", root, ["remote"]);
      if (remotes.split("\n").includes(REMOTE_NAME)) {
        yield* runGit(git, "library.remoteSetUrl", root, [
          "remote",
          "set-url",
          REMOTE_NAME,
          libraryRemoteUrl,
        ]);
      } else {
        yield* runGit(git, "library.remoteAdd", root, [
          "remote",
          "add",
          REMOTE_NAME,
          libraryRemoteUrl,
        ]);
      }
      yield* runGit(git, "library.push", root, ["push", "--set-upstream", REMOTE_NAME, "main"]);
    }).pipe(
      Effect.tap(() => Effect.sync(() => record(null))),
      Effect.catch((error) =>
        Effect.sync(() => record(error instanceof Error ? error.message : String(error))),
      ),
    );
  });
}
