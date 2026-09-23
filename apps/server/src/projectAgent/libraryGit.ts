// FILE: libraryGit.ts
// Purpose: Git operations for the per-group Library — one in-flight queue per
//          library root serializes init/mutate/push so parallel uploads cannot
//          interleave add/commit. Commits are authored as the Synara Library
//          identity; remote pushes are best-effort, non-interactive, and never
//          block a write.
// Layer: Server domain helper
// Exports: withLibraryQueue, withLibraryRootLock, initLibraryRepo, commitLibraryChange,
//          libraryHistory, restoreLibraryEntry, pushLibraryIfConfigured,
//          readLibraryPushStatus, redactLibraryRemoteUrl

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { LIBRARY_REMOTE_URL_PATTERN, type LibraryCommit } from "@synara/contracts";
import { Effect, Semaphore } from "effect";

import { GitCommandError } from "../git/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";

const LIBRARY_AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "Synara Library",
  GIT_AUTHOR_EMAIL: "library@synara.local",
  GIT_COMMITTER_NAME: "Synara Library",
  GIT_COMMITTER_EMAIL: "library@synara.local",
} satisfies NodeJS.ProcessEnv;

// Literal pathspecs keep names like `*.md` or `:(glob)` from being interpreted;
// terminal prompts are disabled so a credential-seeking remote can never stall
// a library write.
const LIBRARY_GIT_ENV = {
  ...LIBRARY_AUTHOR_ENV,
  GIT_LITERAL_PATHSPECS: "1",
  GIT_TERMINAL_PROMPT: "0",
} satisfies NodeJS.ProcessEnv;

const LIBRARY_PUSH_ENV = {
  ...LIBRARY_GIT_ENV,
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
} satisfies NodeJS.ProcessEnv;

const LIBRARY_PUSH_TIMEOUT_MS = 20_000;
// Dead remotes must not be retried on every write: failures back off
// exponentially (30s, 60s, …) up to a 10 minute ceiling.
const LIBRARY_PUSH_BACKOFF_BASE_MS = 30_000;
const LIBRARY_PUSH_BACKOFF_MAX_MS = 10 * 60_000;

const runGit = (
  git: GitCoreShape,
  operation: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = LIBRARY_GIT_ENV,
) =>
  git.execute({
    operation,
    cwd,
    args: [...args],
    env,
  });

const runGitStdout = (
  git: GitCoreShape,
  operation: string,
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Effect.map(runGit(git, operation, cwd, args, env), (result) => result.stdout.trim());

// Strips userinfo from remote URLs so stored errors and surfaced status never
// carry credentials (https://user:pass@host/x.git -> https://host/x.git).
export function redactLibraryRemoteUrl(url: string): string {
  return url.replace(/(https?|ssh):\/\/[^/\s@]+@/g, "$1://");
}

const redactRemoteUrlsInText = (text: string) =>
  text.replace(/(https?|ssh):\/\/[^/\s@]+@/g, "$1://");

const canonicalizeLibraryKey = (target: string) =>
  fs.realpath(target).catch(() => path.resolve(target));

// One keyed semaphore per library root. Locks are dropped once no queued or
// in-flight operation references them.
const lockIndex = Effect.runSync(Semaphore.make(1));
const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

const acquireKeyedLock = (map: typeof locks, key: string) =>
  lockIndex.withPermits(1)(
    Effect.gen(function* () {
      const existing = map.get(key);
      if (existing) {
        existing.users += 1;
        return existing;
      }
      const entry = { lock: yield* Semaphore.make(1), users: 1 };
      map.set(key, entry);
      return entry;
    }),
  );

const releaseKeyedLock = (
  map: typeof locks,
  key: string,
  entry: { readonly lock: Semaphore.Semaphore; users: number },
) =>
  lockIndex.withPermits(1)(
    Effect.sync(() => {
      entry.users -= 1;
      if (entry.users === 0 && map.get(key) === entry) map.delete(key);
    }),
  );

const withKeyedLock = <A, E, R>(
  map: typeof locks,
  key: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    acquireKeyedLock(map, key),
    (entry) => entry.lock.withPermits(1)(effect),
    (entry) => releaseKeyedLock(map, key, entry),
  );

// Serializes filesystem mutations per canonical library root so two groups
// sharing one root cannot interleave add/commit.
export function withLibraryQueue<A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.flatMap(
    Effect.promise(() => canonicalizeLibraryKey(root)),
    (key) => withKeyedLock(locks, key, effect),
  );
}

// Serializes root resolution + relocation per project: configure's libraryPath
// move and request handlers' root lookups must not interleave, or an upload
// could resolve (and write into) the pre-move root.
const rootLockIndex = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

export function withLibraryRootLock<A, E, R>(
  projectId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return withKeyedLock(rootLockIndex, projectId, effect);
}

export function initLibraryRepo(git: GitCoreShape, root: string) {
  // `git symbolic-ref` on the unborn HEAD selects `main` without needing the
  // `git init -b` flag, which only exists on git >= 2.28.
  return runGit(git, "library.init", root, ["init"]).pipe(
    Effect.andThen(
      runGit(git, "library.defaultBranch", root, ["symbolic-ref", "HEAD", "refs/heads/main"]),
    ),
    Effect.asVoid,
  );
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

// `git log --follow` crosses rename boundaries: replaying its --name-status
// output backwards from HEAD yields the name the entry had at any ancestor
// commit, so a restore of "renamed.md" at a pre-rename sha resolves "notes.md".
// `-z` output is NUL-separated so paths with spaces or quotes cannot break the
// parse, and a sha that never touched the path resolves to null instead of the
// oldest walked name.
function resolveLibraryPathAtCommit(
  git: GitCoreShape,
  root: string,
  relativePath: string,
  sha: string,
): Effect.Effect<string | null, GitCommandError> {
  return Effect.gen(function* () {
    const log = yield* runGitStdout(git, "library.pathHistory", root, [
      "log",
      "--format=%H",
      "--follow",
      "-M",
      "--name-status",
      "-z",
      "--",
      relativePath,
    ]);
    let current = relativePath;
    const tokens = log.split("\0").filter((token) => token.length > 0);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (/^[0-9a-f]{40}$/.test(token)) {
        if (token === sha) return current;
        continue;
      }
      // `-z` separates records with NUL but keeps a leading newline on the
      // status field: the rename marker reads "\nR100".
      if (/^R\d*$/.test(token.startsWith("\n") ? token.slice(1) : token)) {
        const from = tokens[index + 1];
        const to = tokens[index + 2];
        if (to === current && from !== undefined) {
          current = from;
        }
        index += 2;
      }
    }
    return null;
  });
}

// Checks out the path at `sha`, then commits the restoration so the timeline
// keeps an explicit record of the rollback. When the entry had a different name
// at that commit, the checkout lands on the historical path and is moved onto
// the current one so the version comes back in place rather than resurrecting
// a stale filename.
export function restoreLibraryEntry(
  git: GitCoreShape,
  root: string,
  relativePath: string,
  sha: string,
): Effect.Effect<{ readonly commitSha: string }, GitCommandError> {
  const invalidSha = () =>
    new GitCommandError({
      operation: "library.restore",
      command: `git checkout ${sha}`,
      cwd: root,
      detail: `Commit "${sha}" is not a valid 40-character library commit sha.`,
    });
  return Effect.gen(function* () {
    // The contract already enforces the pattern; re-check here so the sha can
    // never reach argv as an option (leading `-`) or a ref expression.
    if (!/^[0-9a-f]{40}$/.test(sha)) return yield* invalidSha();
    yield* runGit(git, "library.verifySha", root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${sha}^{commit}`,
    ]).pipe(
      Effect.mapError(
        () =>
          new GitCommandError({
            operation: "library.restore",
            command: `git rev-parse ${sha}`,
            cwd: root,
            detail: `Commit "${sha}" does not exist in this library's history.`,
          }),
      ),
    );
    const pathAtSha = yield* resolveLibraryPathAtCommit(git, root, relativePath, sha);
    if (pathAtSha === null) {
      return yield* new GitCommandError({
        operation: "library.restore",
        command: `git checkout ${sha}`,
        cwd: root,
        detail: `Commit "${sha}" did not change "${relativePath}".`,
      });
    }
    yield* runGit(git, "library.restoreCheckout", root, ["checkout", sha, "--", pathAtSha]);
    if (pathAtSha !== relativePath) {
      // `--` keeps names starting with a dash from parsing as options.
      yield* runGit(git, "library.restoreMove", root, ["mv", "-f", "--", pathAtSha, relativePath]);
    }
    return yield* commitLibraryChange(git, root, `Restore ${relativePath} from ${sha.slice(0, 7)}`);
  });
}

interface LibraryPushRecord {
  readonly at: string;
  readonly error: string | null;
  readonly failCount: number;
}

// Durable record of the last push attempt, kept beside the repo metadata so it
// survives restarts (the library's .git dir is always a real directory here).
const pushStatusPath = (root: string) => path.join(root, ".git", "synara-push-status.json");

const readPushRecord = (root: string) =>
  Effect.promise(async (): Promise<LibraryPushRecord | null> => {
    try {
      const parsed = JSON.parse(await fs.readFile(pushStatusPath(root), "utf8")) as Partial<{
        at: unknown;
        error: unknown;
        failCount: unknown;
      }>;
      if (typeof parsed.at !== "string") return null;
      return {
        at: parsed.at,
        error: typeof parsed.error === "string" ? parsed.error : null,
        failCount: typeof parsed.failCount === "number" ? parsed.failCount : 0,
      };
    } catch {
      return null;
    }
  });

const writePushRecord = (root: string, record: LibraryPushRecord) =>
  Effect.promise(async () => {
    try {
      await fs.writeFile(pushStatusPath(root), JSON.stringify(record), "utf8");
    } catch {
      // Status is best-effort like the push itself.
    }
  });

export function readLibraryPushStatus(root: string): Effect.Effect<
  {
    readonly lastPushAt: string | null;
    readonly lastPushError: string | null;
  },
  never
> {
  return Effect.map(readPushRecord(root), (record) => ({
    lastPushAt: record?.at ?? null,
    lastPushError: record?.error ?? null,
  }));
}

const REMOTE_NAME = "synara-library";

// Pushes to `libraryRemoteUrl` when `libraryPushOnChange` is set. The remote URL
// is managed under a fixed name so edits to the URL re-point the same remote.
// Failures are recorded (redacted, durable) and swallowed: a down remote must
// not break writes. Non-interactive env + short timeout keep a credential-
// prompting or dead remote from stalling the caller.
export function pushLibraryIfConfigured(input: {
  readonly git: GitCoreShape;
  readonly root: string;
  readonly libraryRemoteUrl?: string | undefined;
  readonly libraryPushOnChange?: boolean | undefined;
}): Effect.Effect<void, never> {
  const { git, root, libraryRemoteUrl, libraryPushOnChange } = input;
  return Effect.gen(function* () {
    if (!libraryRemoteUrl || libraryPushOnChange !== true) return;
    const record = (error: string | null, failCount: number) =>
      writePushRecord(root, { at: new Date().toISOString(), error, failCount });
    // The contract validates on write, but stored configs and direct service
    // calls bypass it — a bad URL must never reach `git remote add`.
    if (!LIBRARY_REMOTE_URL_PATTERN.test(libraryRemoteUrl)) {
      yield* record(
        "The library remote URL must start with https:// or ssh:// or use git@host:path form.",
        1,
      );
      return;
    }
    const previous = yield* readPushRecord(root);
    if (previous?.error && previous.failCount > 0) {
      const backoffMs = Math.min(
        LIBRARY_PUSH_BACKOFF_BASE_MS * previous.failCount,
        LIBRARY_PUSH_BACKOFF_MAX_MS,
      );
      if (Date.now() - Date.parse(previous.at) < backoffMs) return;
    }
    yield* Effect.gen(function* () {
      const remotes = yield* runGitStdout(
        git,
        "library.remoteList",
        root,
        ["remote"],
        LIBRARY_PUSH_ENV,
      );
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
      yield* git.execute({
        operation: "library.push",
        cwd: root,
        args: ["push", "--set-upstream", REMOTE_NAME, "main"],
        env: LIBRARY_PUSH_ENV,
        timeoutMs: LIBRARY_PUSH_TIMEOUT_MS,
      });
    }).pipe(
      Effect.tap(() => record(null, 0)),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const detail = error instanceof Error ? error.message : String(error);
          const redacted = redactRemoteUrlsInText(detail);
          const latest = yield* readPushRecord(root);
          const failCount = (latest?.error ? latest.failCount : 0) + 1;
          yield* record(redacted, failCount);
        }),
      ),
    );
  }).pipe(Effect.asVoid);
}
