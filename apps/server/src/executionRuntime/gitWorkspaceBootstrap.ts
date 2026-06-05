/**
 * gitWorkspaceBootstrap - host-side resolution of a GitHub token and the
 * sandbox-side command that clones the project repo into a remote runtime.
 *
 * A remote runtime starts with an empty filesystem: the agent (`codex
 * app-server`) has no repo to work in. Before the agent transport starts, the
 * runtime must clone the project repo into the sandbox so codex runs with its
 * cwd inside the working tree. This module owns the two host/sandbox halves of
 * that, mirroring {@link codexAuthBootstrap}:
 *
 *   - {@link resolveGitHubToken} resolves a token on the HOST so a private repo
 *     can be cloned: it shells `gh auth token`, falling back to the git
 *     credential helper (`git credential fill`). It returns `null` when no token
 *     is available, so provisioning degrades to a clear surfaced error instead of
 *     a crash.
 *
 *   - {@link buildTokenizedRepoUrl} folds a token into an `https://` GitHub URL as
 *     `https://x-access-token:TOKEN@host/...`, and {@link buildGitCloneCommand}
 *     produces a runtime-neutral exec input that clones with that URL, strips the
 *     token back out of the cloned `.git/config`, and checks out the ref.
 *
 * Security: the token must never be logged, surfaced in an error, or left behind
 * in the sandbox. The tokenized URL rides as a base64 positional arg (so it never
 * appears verbatim on the visible command line), and the clone immediately
 * rewrites `origin` to the clean (token-less) URL so the secret is not persisted
 * in `.git/config`. The caller marks the sandbox secret-tainted so it cannot be
 * snapshotted.
 *
 * @module executionRuntime/gitWorkspaceBootstrap
 */
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Stream } from "effect";

import type { ExecutionRuntimeExecCollectInput } from "./Services/ExecutionRuntimeProviderAdapter.ts";

/** Host of the GitHub remote a token is requested for. */
const GITHUB_HOST = "github.com";

const decoder = new TextDecoder();

/**
 * Spawn a host command and collect its stdout + exit code, never failing: a
 * spawn error, a closed pipe, or a non-zero exit degrades to `{ code: 1 }`. Used
 * for the two host credential probes (`gh auth token`, `git credential fill`),
 * each of which the caller treats as best-effort. `stdin`, when set, is fed as a
 * one-shot stream so a command that reads a request (credential fill) gets it.
 */
const runHostCommand = (
  command: string,
  args: ReadonlyArray<string>,
  stdin?: string,
): Effect.Effect<
  { readonly code: number; readonly stdout: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const options =
      stdin === undefined
        ? { env: { ...process.env } }
        : { env: { ...process.env }, stdin: Stream.make(new TextEncoder().encode(stdin)) };
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make(command, [...args], options));
        const [stdout, code] = yield* Effect.all(
          [
            Stream.runFold(
              child.stdout,
              () => "",
              (acc: string, chunk: Uint8Array) => acc + decoder.decode(chunk),
            ).pipe(Effect.orElseSucceed(() => "")),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.orElseSucceed(() => 1),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return { code, stdout };
      }),
    ).pipe(Effect.orElseSucceed(() => ({ code: 1, stdout: "" })));
  });

/**
 * Parse a `key=value` line block (the `git credential fill` answer) for the
 * `password` field — the token git would use for an HTTPS push/fetch.
 */
const parseCredentialPassword = (output: string): string | null => {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("password=")) {
      const value = trimmed.slice("password=".length).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
};

/**
 * Resolve a GitHub token on the host so a private repo can be cloned into a
 * remote sandbox. Tries `gh auth token` first (the user's logged-in CLI), then
 * the git credential helper (`git credential fill` for `protocol=https
 * host=github.com`). Returns `null` when neither yields a token, so the caller
 * degrades to a clear surfaced error rather than crashing the session. Never
 * logs the resolved token.
 */
export const resolveGitHubToken = (
  host: string = GITHUB_HOST,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const ghResult = yield* runHostCommand("gh", ["auth", "token"]);
    if (ghResult.code === 0) {
      const token = ghResult.stdout.trim();
      if (token.length > 0) {
        return token;
      }
    }
    // Fallback: ask git's configured credential helper for the HTTPS password.
    const fillResult = yield* runHostCommand(
      "git",
      ["credential", "fill"],
      `protocol=https\nhost=${host}\n\n`,
    );
    if (fillResult.code === 0) {
      return parseCredentialPassword(fillResult.stdout);
    }
    return null;
  });

/**
 * Whether a repo URL is an `https://github.com/...` URL a token can be folded
 * into. An `ssh`/`git@`/non-github URL is returned to the caller unchanged so a
 * differently-authenticated remote is not silently broken.
 */
export const isTokenizableHttpsUrl = (repoUrl: string, host: string = GITHUB_HOST): boolean => {
  try {
    const url = new URL(repoUrl);
    return url.protocol === "https:" && url.host === host;
  } catch {
    return false;
  }
};

/**
 * Fold a token into an `https://github.com/...` URL as
 * `https://x-access-token:TOKEN@host/...`. Returns the URL unchanged when it is
 * not a tokenizable HTTPS GitHub URL (the token would not help) or when no token
 * is supplied.
 */
export const buildTokenizedRepoUrl = (
  repoUrl: string,
  token: string | null,
  host: string = GITHUB_HOST,
): string => {
  if (token === null || token.trim().length === 0 || !isTokenizableHttpsUrl(repoUrl, host)) {
    return repoUrl;
  }
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
};

export interface GitCloneCommandInput {
  /** The clone URL (may carry an embedded token); rides as a base64 arg. */
  readonly tokenizedUrl: string;
  /** The token-less URL written back to `origin` after clone. */
  readonly cleanUrl: string;
  /** Absolute dir inside the sandbox to clone into. */
  readonly targetPath: string;
  /** Branch to `checkout -B` after clone. */
  readonly ref: string;
}

/**
 * Build the exec that clones the repo into the sandbox, strips the token from
 * the cloned `.git/config`, and checks out the ref. The (possibly tokenized) URL
 * and the clean URL ride as base64 positional args (`$0`, `$1`) so neither the
 * token nor any URL can break the shell or appear verbatim on the visible
 * command line. The ref is checked out at its origin commit when it exists on the
 * remote (so a feature branch resolves to origin/<ref>, not the cloned default
 * HEAD), and created from HEAD when it does not. After the ref is resolved,
 * `origin` is rewritten to the clean URL so the token is never persisted on the
 * sandbox filesystem.
 */
export const buildGitCloneCommand = (
  input: GitCloneCommandInput,
): ExecutionRuntimeExecCollectInput => {
  const tokenizedB64 = Buffer.from(input.tokenizedUrl, "utf8").toString("base64");
  const cleanB64 = Buffer.from(input.cleanUrl, "utf8").toString("base64");
  const targetB64 = Buffer.from(input.targetPath, "utf8").toString("base64");
  const refB64 = Buffer.from(input.ref, "utf8").toString("base64");
  const script = [
    "set -e",
    'url="$(printf %s "$0" | base64 -d)"',
    'clean="$(printf %s "$1" | base64 -d)"',
    'target="$(printf %s "$2" | base64 -d)"',
    'ref="$(printf %s "$3" | base64 -d)"',
    // Clone fresh; if the target already exists from a prior attempt, reuse it.
    'if [ ! -d "$target/.git" ]; then git clone "$url" "$target"; fi',
    // Resolve the ref to its origin commit, not the cloned default HEAD: a feature
    // branch must check out origin/<ref>, else the agent gets main's tree under the
    // branch name. ls-remote gates the fetch so a not-yet-pushed branch falls back
    // to creating it from HEAD. Done before the token is stripped so the private
    // fetch still authenticates.
    'if git -C "$target" ls-remote --exit-code --heads origin "$ref" >/dev/null 2>&1; then git -C "$target" fetch origin "$ref" && git -C "$target" checkout -B "$ref" FETCH_HEAD; else git -C "$target" checkout -B "$ref"; fi',
    // Strip the token: rewrite origin to the clean (token-less) URL so the secret
    // is not left behind in .git/config on a snapshot-eligible sandbox.
    'git -C "$target" remote set-url origin "$clean"',
    "echo git-workspace-ready",
  ].join(" && ");
  return {
    command: "bash",
    args: ["-lc", script, tokenizedB64, cleanB64, targetB64, refB64],
  };
};

/**
 * The sentinel that opts into lockfile-based package-manager auto-detection
 * instead of a literal command. An operator sets `postCloneCommand` to `auto` to
 * run the right install for whatever lockfile the cloned repo ships.
 */
export const POST_CLONE_AUTO_DETECT = "auto";

/**
 * Build the exec that runs an opt-in post-clone command inside the clone dir, or
 * `null` when nothing should run (the default).
 *
 * `command` is the operator's raw setting:
 *   - blank -> `null` (off; the default, so a provision costs nothing extra).
 *   - `auto` -> a lockfile-detecting install (`bun.lock`/`bun.lockb` -> bun,
 *     `pnpm-lock.yaml` -> pnpm, `package-lock.json` -> npm; none -> a no-op echo).
 *   - anything else -> that literal command, run via `eval` in the clone dir.
 *
 * The command and the dir ride as base64 positional args (`$0`, `$1`) so neither
 * can break the shell or appear awkwardly on the visible command line, and the
 * script `cd`s into the dir first so the command lands in the working tree. The
 * caller runs this best-effort and never fatally blocks the session on a non-zero
 * exit.
 */
export const buildPostCloneCommand = (
  command: string,
  cloneDir: string,
): ExecutionRuntimeExecCollectInput | null => {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const dirB64 = Buffer.from(cloneDir, "utf8").toString("base64");
  if (trimmed.toLowerCase() === POST_CLONE_AUTO_DETECT) {
    const script = [
      "set -e",
      'dir="$(printf %s "$0" | base64 -d)"',
      'cd "$dir"',
      "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install;",
      "elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile;",
      "elif [ -f package-lock.json ]; then npm ci;",
      'else echo "no lockfile; skipping dependency install"; fi',
    ].join("\n");
    return { command: "bash", args: ["-lc", script, dirB64] };
  }
  const commandB64 = Buffer.from(trimmed, "utf8").toString("base64");
  const script = [
    "set -e",
    'dir="$(printf %s "$0" | base64 -d)"',
    'cmd="$(printf %s "$1" | base64 -d)"',
    'cd "$dir"',
    'eval "$cmd"',
  ].join(" && ");
  return { command: "bash", args: ["-lc", script, dirB64, commandB64] };
};
