/**
 * DaytonaRuntimeAdapter - the Daytona provider boundary.
 *
 * Pairs the static {@link DAYTONA_RUNTIME_DESCRIPTOR} with the lifecycle
 * operations a remote runtime needs, expressed over {@link DaytonaSandboxClient}
 * so the same code drives the fake (local temp dirs) and the real (REST) client:
 *
 *   - `provision`        create/resume a sandbox -> `RuntimeInstanceSummary`.
 *   - `createTransport`  start the agent session and bridge its stdio into the
 *                        in-memory `JsonRpcLineTransport` Codex consumes.
 *   - `execCollect`      fire-and-collect command exec (runtime-neutral git v1).
 *   - `exposePort`       on-demand preview URL.
 *   - `snapshot`         persist for resume.
 *   - `refreshActivity`  the activity-lease keepalive (Daytona auto-stops idle).
 *   - `stop` / `isAlive` / `destroy`  lifecycle, liveness, teardown.
 *
 * The adapter never touches orchestration commands or persistence: recording
 * lifecycle is `ExecutionRuntimeService`'s job. This keeps it a pure provider
 * boundary, structurally identical to `FakeRuntimeProviderAdapter`, so the
 * reconciler's provider-agnostic `getStatus`/liveness probe and the git
 * workspace plug in unchanged.
 *
 * @module daytona/DaytonaRuntimeAdapter
 */
import { ExecutionInstanceId, type RuntimeInstanceSummary } from "@t3tools/contracts";
import { Deferred, Effect, Exit, Layer, Scope, ServiceMap, Stream } from "effect";

import {
  makeInMemoryJsonRpcTransport,
  type InMemoryTransportController,
  type JsonRpcLineTransport,
} from "../../../provider/process/JsonRpcLineTransport.ts";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../../../provider/codexCliVersion.ts";
import {
  buildCodexAuthInjectionCommand,
  buildCodexInstructionsInjectionCommand,
  buildMinimalCodexConfigCommand,
  resolveOperatorCodexAuth,
  resolveOperatorCodexInstructions,
} from "../../codexAuthBootstrap.ts";
import { buildGitCloneCommand } from "../../gitWorkspaceBootstrap.ts";
import { redactSecrets } from "../../Layers/redactCredentials.ts";
import type { RuntimeProcessSpawnInput } from "../../Services/RuntimeProcessTransport.ts";
import { DaytonaApiError } from "./DaytonaErrors.ts";
import {
  DaytonaSandboxClient,
  type DaytonaExecInput,
  type DaytonaExposePortResult,
  type DaytonaSnapshotResult,
} from "./DaytonaSandboxClient.ts";

/** Result of a fire-and-collect command run inside a sandbox. */
export interface DaytonaExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface DaytonaProvisionRepoSource {
  /** Token-less origin URL written back to `origin` after clone. */
  readonly repoUrl: string;
  /** Branch to `checkout -B` after clone. */
  readonly ref: string;
  /** Tokenized clone URL (carries a secret — never log it). */
  readonly tokenizedUrl: string;
  /** Dir name joined with the discovered sandbox root to form the clone dir. */
  readonly targetSubdir: string;
}

export interface DaytonaProvisionInput {
  readonly threadId: string;
  readonly ports: ReadonlyArray<number>;
  readonly snapshotId: string | null;
  /**
   * Repo to clone into the sandbox after it is ready. When present (and the
   * sandbox is a real remote one), provision clones it into `cloneDir` and makes
   * that the recorded root so codex runs with its cwd inside the working tree.
   */
  readonly repoSource?: DaytonaProvisionRepoSource;
}

export interface DaytonaInstanceContext {
  readonly instance: RuntimeInstanceSummary;
  readonly rootPath: string;
}

export interface DaytonaRuntimeAdapterShape {
  /** Create (or resume) a Daytona sandbox backing a thread. */
  readonly provision: (
    input: DaytonaProvisionInput,
  ) => Effect.Effect<DaytonaInstanceContext, DaytonaApiError>;
  /**
   * Start the agent process inside the sandbox and return its in-memory line
   * transport plus the controller (the remote forwarding seam). The consumer
   * sees only the transport — the same shape a local child produces — never a
   * sandbox session handle.
   */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: RuntimeProcessSpawnInput,
  ) => Effect.Effect<
    {
      readonly transport: JsonRpcLineTransport;
      readonly controller: InMemoryTransportController;
    },
    DaytonaApiError
  >;
  /** Fire-and-collect command exec (git rides this). */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: DaytonaExecInput,
  ) => Effect.Effect<DaytonaExecResult, DaytonaApiError>;
  /**
   * Re-write the host operator's Codex auth into a resumed sandbox. ChatGPT
   * tokens expire, so a sandbox resumed from a prior session can carry a stale
   * `auth.json`; this overwrites it with the current host login before the next
   * turn. Best-effort and remote-only (it shares `injectCodexCredentials`' gate),
   * so a local/fake instance is untouched and a missing host login is a no-op.
   */
  readonly reinjectCredentials: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
  /** Expose a port and return a preview URL. */
  readonly exposePort: (
    instanceId: ExecutionInstanceId,
    port: number,
  ) => Effect.Effect<DaytonaExposePortResult, DaytonaApiError>;
  /** Snapshot the sandbox for later resume. */
  readonly snapshot: (
    instanceId: ExecutionInstanceId,
    label: string | null,
  ) => Effect.Effect<DaytonaSnapshotResult, DaytonaApiError>;
  /** Refresh the auto-stop timer (the activity-lease keepalive). */
  readonly refreshActivity: (
    instanceId: ExecutionInstanceId,
  ) => Effect.Effect<void, DaytonaApiError>;
  /** Stop the sandbox without destroying it (FS persists). */
  readonly stop: (instanceId: ExecutionInstanceId) => Effect.Effect<void, DaytonaApiError>;
  /**
   * Whether the provider still recognizes a sandbox as live. The reconciler reads
   * this as the provider-agnostic liveness probe: a DB row the provider no longer
   * knows about (or one that errored) is a lost instance.
   */
  readonly isAlive: (instanceId: ExecutionInstanceId) => Effect.Effect<boolean>;
  /** Archive then delete the sandbox. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}

export class DaytonaRuntimeAdapter extends ServiceMap.Service<
  DaytonaRuntimeAdapter,
  DaytonaRuntimeAdapterShape
>()("t3/executionRuntime/providers/daytona/DaytonaRuntimeAdapter") {}

const toExecInput = (spawn: RuntimeProcessSpawnInput): DaytonaExecInput => ({
  command: spawn.command,
  args: spawn.args,
  cwd: spawn.cwd,
  env: spawn.env,
});

// Join a sandbox-absolute root with a subdir, POSIX-style (the sandbox is Linux).
// `node:path` would use the host separator, so it is not used here.
const joinSandboxPath = (root: string, subdir: string): string =>
  `${root.replace(/\/+$/, "")}/${subdir.replace(/^\/+/, "")}`;

export interface DaytonaRuntimeAdapterOptions {
  /**
   * Host environment used to resolve the operator's Codex auth for injection.
   * Defaults to `process.env`; tests inject a fixed env (or a base Codex home
   * with no `auth.json`) to assert the injection path without a real login.
   */
  readonly env?: NodeJS.ProcessEnv;
}

const makeDaytonaRuntimeAdapter = (options: DaytonaRuntimeAdapterOptions = {}) =>
  Effect.gen(function* () {
    const client = yield* DaytonaSandboxClient;
    const hostEnv = options.env ?? process.env;
    // Sandbox id is the durable provider id; the contract `ExecutionInstanceId` is
    // the same string, so reconnect after restart works off the persisted id alone.
    const sandboxRoots = new Map<string, string>();
    // Sandbox ids whose filesystem holds injected host credentials. Snapshotting a
    // tainted sandbox would bake expiring ChatGPT tokens into a reusable base
    // image (g8), so `snapshot` refuses a tainted id. Cleared on destroy.
    const secretTainted = new Set<string>();

    // Discover the sandbox's real working dir by polling `pwd`. It is image-
    // dependent (a snapshot may run as root at /root, the default image at
    // /home/daytona, ...), so a hardcoded root breaks `cd` for the agent process.
    // The retry doubles as the readiness wait: exec errors until the sandbox is
    // running. Falls back to the client's rootPath if discovery never succeeds.
    //
    // `pwd` now runs under `bash -lc`, whose login profile may print a banner
    // before the working dir; take the LAST absolute-path line rather than
    // requiring the whole stdout to be the path, so a `/etc/profile` preamble does
    // not defeat discovery.
    const lastAbsolutePathLine = (stdout: string): string | undefined => {
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/"));
      return lines.at(-1);
    };
    // Backoff schedule for the readiness wait: ramp 100ms,200ms,400ms,...,2s then
    // hold at the 2s cap. A sandbox ready in ~300ms is detected in ~3 attempts
    // (~700ms total) instead of waiting a flat 2s per attempt, while the cap keeps
    // the total budget (~80s over DISCOVER_ROOT_ATTEMPTS) close to the old flat
    // 2s x40 loop for a genuinely slow cold start.
    const DISCOVER_ROOT_BASE_DELAY_MS = 100;
    const DISCOVER_ROOT_MAX_DELAY_MS = 2000;
    const DISCOVER_ROOT_ATTEMPTS = 43;
    const backoffDelayMs = (attemptIndex: number): number =>
      Math.min(DISCOVER_ROOT_BASE_DELAY_MS * 2 ** attemptIndex, DISCOVER_ROOT_MAX_DELAY_MS);
    const discoverRoot = (sandboxId: string, fallback: string): Effect.Effect<string> => {
      const attempt = (remaining: number): Effect.Effect<string> =>
        client.exec(sandboxId, { command: "pwd", args: [] }).pipe(
          Effect.flatMap((result) => {
            const path = result.exitCode === 0 ? lastAbsolutePathLine(result.stdout) : undefined;
            return path !== undefined
              ? Effect.succeed(path)
              : Effect.fail(
                  new DaytonaApiError({
                    operation: "provision",
                    status: null,
                    detail: "sandbox not ready",
                  }),
                );
          }),
          Effect.catch(() =>
            remaining <= 0
              ? Effect.succeed(fallback)
              : Effect.sleep(backoffDelayMs(DISCOVER_ROOT_ATTEMPTS - remaining)).pipe(
                  Effect.flatMap(() => attempt(remaining - 1)),
                ),
          ),
        );
      return attempt(DISCOVER_ROOT_ATTEMPTS);
    };

    // Install the host operator's Codex auth (and a minimal config when the image
    // ships none) into the sandbox before the agent transport starts. Runs through
    // the same toolbox exec git rides, which wraps the command in `bash -lc`, so
    // `$HOME` resolves to the sandbox user's home and codex finds its auth there.
    // Best-effort: a missing host login or a failed write is logged via the exec
    // result and does not fail provisioning — codex surfaces its own auth error on
    // the first turn rather than the sandbox failing to provision.
    const injectCodexCredentials = (sandboxId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Only inject into a real remote sandbox. The fake client runs commands as
        // local child processes that share the host's real `$HOME`, so writing
        // `$HOME/.codex/auth.json` there would clobber the developer's own login —
        // the local/worktree path must stay byte-for-byte unaffected.
        if (client.isRemoteSandbox?.(sandboxId) !== true) {
          return;
        }
        const auth = resolveOperatorCodexAuth(hostEnv);
        if (auth === null) {
          return;
        }
        yield* client.exec(sandboxId, buildCodexAuthInjectionCommand(auth)).pipe(Effect.ignore);
        yield* client.exec(sandboxId, buildMinimalCodexConfigCommand()).pipe(Effect.ignore);
        const instructions = resolveOperatorCodexInstructions(hostEnv);
        if (instructions !== null) {
          yield* client
            .exec(sandboxId, buildCodexInstructionsInjectionCommand(instructions))
            .pipe(Effect.ignore);
        }
        // Auth bytes now live on the sandbox FS: forbid snapshotting it.
        secretTainted.add(sandboxId);
      });

    // Probe that codex is installed and new enough inside the sandbox, so a
    // codex-less or stale snapshot fails provisioning with an actionable error
    // (g9) instead of a late opaque JSON/transport error at the first turn. Runs
    // through the same toolbox exec git rides (wrapped in `bash -lc`, so codex is
    // on PATH), and gates the parsed version against the manager's handshake
    // minimum. Remote-only: the fake/local client shares the host shell, which
    // already passed the local CLI gate. A missing/unparseable version with a
    // zero exit is accepted — the binary answered, just not in a parseable shape.
    const assertCodexPresent = (sandboxId: string): Effect.Effect<void, DaytonaApiError> =>
      Effect.gen(function* () {
        if (client.isRemoteSandbox?.(sandboxId) !== true) {
          return;
        }
        const result = yield* client
          .exec(sandboxId, { command: "codex", args: ["--version"] })
          .pipe(
            Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
              Effect.fail(
                new DaytonaApiError({
                  operation: "provision",
                  status: null,
                  detail: error.message,
                }),
              ),
            ),
          );
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new DaytonaApiError({
              operation: "provision",
              status: null,
              detail:
                "snapshot has no compatible codex: `codex --version` failed inside the sandbox. " +
                "Provision from a snapshot that has the Codex CLI installed.",
            }),
          );
        }
        const version = parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
        if (version !== null && !isCodexCliVersionSupported(version)) {
          return yield* Effect.fail(
            new DaytonaApiError({
              operation: "provision",
              status: null,
              detail: `snapshot codex is too old: ${formatCodexCliUpgradeMessage(version)}`,
            }),
          );
        }
      });

    // Clone the project repo into the sandbox so codex runs with its cwd inside
    // the working tree. Runs the same toolbox exec git/auth ride (wrapped in
    // `bash -lc`), so it lands on the sandbox filesystem. The clone command folds
    // the host token into the URL, then strips it back out of `.git/config`, so
    // the secret is never persisted; we still taint the sandbox so a snapshot
    // refuses it (defense in depth). Remote-only: the fake/local client shares the
    // host filesystem and already has the repo, so cloning there would clobber the
    // developer's checkout. A clone failure fails provisioning with a redacted,
    // actionable message (mirrors assertCodexPresent) rather than a late opaque
    // codex error when it cannot find the repo.
    const cloneRepoIntoSandbox = (
      sandboxId: string,
      repo: NonNullable<DaytonaProvisionInput["repoSource"]>,
      cloneDir: string,
    ): Effect.Effect<void, DaytonaApiError> =>
      Effect.gen(function* () {
        // The tokenized URL carries the secret; redact it (and the clean URL) from
        // any surfaced error so a failing git command can never leak the token.
        const secrets = [repo.tokenizedUrl, repo.repoUrl];
        const command = buildGitCloneCommand({
          tokenizedUrl: repo.tokenizedUrl,
          cleanUrl: repo.repoUrl,
          targetPath: cloneDir,
          ref: repo.ref,
        });
        // Auth bytes / a token-bearing clone touched the FS: forbid snapshotting it
        // even though the clone strips the token from .git/config afterward.
        secretTainted.add(sandboxId);
        const result = yield* client.exec(sandboxId, command).pipe(
          Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
            Effect.fail(
              new DaytonaApiError({
                operation: "provision",
                status: null,
                detail: redactSecrets(error.message, secrets),
              }),
            ),
          ),
        );
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new DaytonaApiError({
              operation: "provision",
              status: null,
              detail: redactSecrets(
                `failed to clone the project repo into the sandbox: ` +
                  `git exited ${result.exitCode ?? "null"}: ` +
                  `${result.stderr.trim() || result.stdout.trim()}`,
                secrets,
              ),
            }),
          );
        }
      });

    const provision: DaytonaRuntimeAdapterShape["provision"] = (input) =>
      Effect.gen(function* () {
        const sandbox = yield* client.create({
          threadId: input.threadId,
          ports: input.ports,
          snapshotId: input.snapshotId,
        });
        const discoveredRoot = yield* discoverRoot(sandbox.id, sandbox.rootPath);
        // Auth injection (best-effort, null-degrades) and the codex-presence probe
        // (fail-fast on missing/old codex, mapped to RuntimeProvisionFailedError)
        // touch disjoint paths, so run them concurrently to drop a serial toolbox
        // round-trip from cold start. assertCodexPresent's failure still aborts the
        // whole provision before the instance is recorded.
        yield* Effect.all([injectCodexCredentials(sandbox.id), assertCodexPresent(sandbox.id)], {
          concurrency: "unbounded",
        });
        // Clone the repo AFTER auth is in place, then make the clone dir the
        // recorded root so codex's session cwd and in-sandbox exec cwd both land
        // inside the working tree. Remote-only: the fake/local client shares the
        // host filesystem and already has the repo, so cloning there would clobber
        // the developer's checkout — the root stays the discovered sandbox root.
        // With no repo source the root is also the discovered root, unchanged.
        const repoSource = input.repoSource;
        const cloneDir =
          repoSource !== undefined && client.isRemoteSandbox?.(sandbox.id) === true
            ? joinSandboxPath(discoveredRoot, repoSource.targetSubdir)
            : undefined;
        if (repoSource !== undefined && cloneDir !== undefined) {
          yield* cloneRepoIntoSandbox(sandbox.id, repoSource, cloneDir);
        }
        const rootPath = cloneDir ?? discoveredRoot;
        sandboxRoots.set(sandbox.id, rootPath);
        const instanceId = ExecutionInstanceId.makeUnsafe(sandbox.id);
        const now = new Date().toISOString();
        const instance: RuntimeInstanceSummary = {
          id: instanceId,
          provider: "daytona",
          status: "running",
          rootPath,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
        };
        return { instance, rootPath };
      });

    const createTransport: DaytonaRuntimeAdapterShape["createTransport"] = (instanceId, spawn) =>
      Effect.gen(function* () {
        const built = yield* makeInMemoryJsonRpcTransport();
        const session = yield* client.startSession(String(instanceId), toExecInput(spawn));
        const forwardScope = yield* Scope.make();

        // Remote stdout/stderr -> in-memory transport inbound/stderr.
        yield* session.stdoutLines.pipe(
          Stream.runForEach((line) => built.controller.pushInbound(line)),
          Effect.ignore,
          Effect.forkIn(forwardScope),
        );
        yield* session.stderrLines.pipe(
          Stream.runForEach((line) => built.controller.pushStderr(line)),
          Effect.ignore,
          Effect.forkIn(forwardScope),
        );

        // Consumer outbound frames -> remote stdin. `takeOutbound` fails with
        // `Cause.Done` once the transport closes and drains, ending the relay.
        yield* built.controller.takeOutbound.pipe(
          Effect.flatMap((line) => session.writeStdin(line)),
          Effect.forever,
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(forwardScope),
        );

        // Remote exit -> consumer exit signal.
        yield* session.exit.pipe(
          Effect.flatMap((status) => built.controller.signalExit(status)),
          Effect.forkIn(forwardScope),
        );

        // Transport close -> tear the remote session and relays down.
        yield* Deferred.await(built.transport.exit).pipe(
          Effect.flatMap(() => session.close),
          Effect.flatMap(() => Scope.close(forwardScope, Exit.void)),
          Effect.ignore,
          Effect.forkDetach,
        );

        return { transport: built.transport, controller: built.controller };
      }).pipe(
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({
              operation: "createTransport",
              status: null,
              detail: error.message,
            }),
          ),
        ),
      );

    const execCollect: DaytonaRuntimeAdapterShape["execCollect"] = (instanceId, input) =>
      client.exec(String(instanceId), input).pipe(
        Effect.map((result) => ({
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.exitCode,
        })),
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({
              operation: "execCollect",
              status: null,
              detail: error.message,
            }),
          ),
        ),
      );

    const exposePort: DaytonaRuntimeAdapterShape["exposePort"] = (instanceId, port) =>
      client.exposePort(String(instanceId), port).pipe(
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({
              operation: "exposePort",
              status: null,
              detail: error.message,
            }),
          ),
        ),
      );

    const reinjectCredentials: DaytonaRuntimeAdapterShape["reinjectCredentials"] = (instanceId) =>
      injectCodexCredentials(String(instanceId));

    const snapshot: DaytonaRuntimeAdapterShape["snapshot"] = (instanceId, label) =>
      Effect.suspend(() => {
        // Refuse to snapshot a sandbox that holds injected host credentials: the
        // image would bake expiring ChatGPT tokens for any future resume (g8).
        if (secretTainted.has(String(instanceId))) {
          return Effect.fail(
            new DaytonaApiError({
              operation: "snapshot",
              status: null,
              detail:
                "refusing to snapshot a sandbox with injected codex credentials " +
                "(would bake expiring tokens into the image)",
            }),
          );
        }
        return client.snapshot(String(instanceId), label).pipe(
          Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
            Effect.fail(
              new DaytonaApiError({
                operation: "snapshot",
                status: null,
                detail: error.message,
              }),
            ),
          ),
        );
      });

    const refreshActivity: DaytonaRuntimeAdapterShape["refreshActivity"] = (instanceId) =>
      client.refreshActivity(String(instanceId)).pipe(
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({
              operation: "refreshActivity",
              status: null,
              detail: error.message,
            }),
          ),
        ),
      );

    const stop: DaytonaRuntimeAdapterShape["stop"] = (instanceId) =>
      client.stop(String(instanceId)).pipe(
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({
              operation: "stop",
              status: null,
              detail: error.message,
            }),
          ),
        ),
      );

    const isAlive: DaytonaRuntimeAdapterShape["isAlive"] = (instanceId) =>
      client.getStatus(String(instanceId)).pipe(
        Effect.map((sandbox) => sandbox !== null && sandbox.status === "running"),
        Effect.orElseSucceed(() => false),
      );

    const destroy: DaytonaRuntimeAdapterShape["destroy"] = (instanceId) =>
      Effect.sync(() => {
        sandboxRoots.delete(String(instanceId));
        secretTainted.delete(String(instanceId));
      }).pipe(
        Effect.flatMap(() => client.destroy(String(instanceId))),
        Effect.ignore,
      );

    return {
      provision,
      createTransport,
      execCollect,
      reinjectCredentials,
      exposePort,
      snapshot,
      refreshActivity,
      stop,
      isAlive,
      destroy,
    } satisfies DaytonaRuntimeAdapterShape;
  });

export const makeDaytonaRuntimeAdapterEffect = makeDaytonaRuntimeAdapter;

/**
 * The Daytona adapter layer. `options.env` is the host environment used to
 * resolve the operator's Codex auth for injection; it defaults to `process.env`,
 * so the unit/contract suites (which never override it) keep the zero-arg form.
 */
export const makeDaytonaRuntimeAdapterServiceLive = (
  options: DaytonaRuntimeAdapterOptions = {},
): Layer.Layer<DaytonaRuntimeAdapter, never, DaytonaSandboxClient> =>
  Layer.effect(DaytonaRuntimeAdapter, makeDaytonaRuntimeAdapter(options));

export const DaytonaRuntimeAdapterLive = makeDaytonaRuntimeAdapterServiceLive();
