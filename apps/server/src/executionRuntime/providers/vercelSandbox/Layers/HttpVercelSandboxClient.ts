/**
 * HttpVercelSandboxClient - the real `@vercel/sandbox` client (credential-gated).
 *
 * Selected only when the `VERCEL_*` credentials are present; otherwise the
 * adapter uses the fake client. Vercel Sandbox is command/log/file/preview-first
 * (no PTY, no host pid): the agent runs as a detached command whose structured
 * `logs()` are line-framed into stdout/stderr streams, git/setup commands are
 * fire-and-collect, ports are declared at create and resolved via `domain()`,
 * and the filesystem is ephemeral unless snapshotted.
 *
 * The `@vercel/sandbox` package is an optional dependency loaded lazily through
 * {@link loadVercelSandboxSdk}; a credentialed run without the package installed
 * fails loudly. Credential safety: the token never reaches a log or an error
 * detail — every failure runs through {@link redactSecrets} with the token
 * registered.
 *
 * @module vercelSandbox/HttpVercelSandboxClient
 */
import { Cause, Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";

import { RuntimeRemoteOperationFailedError } from "../../../Errors.ts";
import { redactSecrets } from "../../../Layers/redactCredentials.ts";
import type { VercelSandboxCredentials } from "./VercelSandboxConfig.ts";
import {
  loadVercelSandboxSdk,
  type VercelSandboxSdkLoader,
  type VercelSdkCommand,
  type VercelSdkFinishedCommand,
  type VercelSdkLogEntry,
  type VercelSdkRunCommandInput,
  type VercelSdkSandbox,
} from "./vercelSandboxSdk.ts";
import {
  VercelSandboxClient,
  type VercelSandboxClientShape,
  type VercelSandboxCommandHandle,
  type VercelSandboxCommandInput,
  type VercelSandboxCommandResult,
  type VercelSandboxCreated,
  type VercelSandboxId,
  type VercelSandboxPort,
} from "../Services/VercelSandboxClient.ts";

/** Absolute working directory root inside a Vercel sandbox. */
const SANDBOX_ROOT = "/vercel/sandbox";
const DEFAULT_RUNTIME = "node24";

/** A detached command exposes a writable stdin; a finished one does not. */
const isDetachedCommand = (
  command: VercelSdkCommand | VercelSdkFinishedCommand,
): command is VercelSdkCommand =>
  typeof (command as VercelSdkCommand).logs === "function" &&
  typeof (command as VercelSdkCommand).wait === "function";

/** Decode a log entry's `data` to text (the SDK may hand back bytes or a string). */
const logEntryText = (entry: VercelSdkLogEntry): string =>
  typeof entry.data === "string" ? entry.data : new TextDecoder().decode(entry.data);

/** Decode a `readFile` result into bytes across the shapes the SDK may return. */
const readFileToBytes = async (
  result: Uint8Array | { stream(): AsyncIterable<Uint8Array> } | string,
): Promise<Uint8Array> => {
  if (typeof result === "string") {
    return new TextEncoder().encode(result);
  }
  if (result instanceof Uint8Array) {
    return result;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of result.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const runCommandInput = (
  input: VercelSandboxCommandInput,
  detached: boolean,
): VercelSdkRunCommandInput => ({
  cmd: input.command,
  args: [...input.args],
  ...(input.cwd === undefined || input.cwd.length === 0 ? {} : { cwd: input.cwd }),
  ...(input.env === undefined ? {} : { env: input.env }),
  detached,
});

/**
 * `domain` is synchronous in the SDK; a failure (e.g. an undeclared port) yields
 * a null URL so `create` still succeeds with whatever ports did route.
 */
const resolveDomain = (sandbox: VercelSdkSandbox, port: number): string | null => {
  try {
    return sandbox.domain(port);
  } catch {
    return null;
  }
};

export const makeHttpVercelSandboxClient = (
  credentials: VercelSandboxCredentials,
  loadSdk: VercelSandboxSdkLoader = loadVercelSandboxSdk,
) =>
  Effect.gen(function* () {
    const secrets = [credentials.token];
    const redact = (value: string): string => redactSecrets(value, secrets);

    const fail = (operation: string, cause: unknown) =>
      new RuntimeRemoteOperationFailedError({
        provider: "vercel-sandbox",
        operation,
        detail: redact(cause instanceof Error ? cause.message : String(cause)),
      });

    // Load the optional SDK lazily and once. Deferring keeps layer construction
    // infallible (so the layer's error channel stays `never` and unifies with
    // the fake); a credentialed run without the package installed fails loudly
    // on first use rather than degrading to the fake.
    const getSdk = yield* Effect.cached(
      Effect.tryPromise({
        try: loadSdk,
        catch: (cause) => fail("loadSdk", cause),
      }),
    );

    // Cache live sandbox handles so post-create operations reuse the instance the
    // SDK returned. A miss (e.g. after a server restart) reconnects via `get`.
    const handles = yield* Ref.make(new Map<VercelSandboxId, VercelSdkSandbox>());

    const rememberHandle = (sandbox: VercelSdkSandbox) =>
      Ref.update(handles, (map) => {
        const next = new Map(map);
        next.set(sandbox.sandboxId, sandbox);
        return next;
      });

    const reconnect = (sandboxId: VercelSandboxId) =>
      getSdk.pipe(
        Effect.flatMap((sdk) =>
          Effect.tryPromise({
            try: () =>
              sdk.Sandbox.get({
                sandboxId,
                token: credentials.token,
                teamId: credentials.teamId,
                projectId: credentials.projectId,
              }),
            catch: (cause) => fail("reconnect", cause),
          }),
        ),
        Effect.tap(rememberHandle),
      );

    const requireSandbox = (operation: string, sandboxId: VercelSandboxId) =>
      Ref.get(handles).pipe(
        Effect.flatMap((map) => {
          const existing = map.get(sandboxId);
          return existing === undefined ? reconnect(sandboxId) : Effect.succeed(existing);
        }),
        Effect.mapError((error) =>
          error instanceof RuntimeRemoteOperationFailedError
            ? new RuntimeRemoteOperationFailedError({
                provider: "vercel-sandbox",
                operation,
                detail: error.detail,
              })
            : fail(operation, error),
        ),
      );

    const create: VercelSandboxClientShape["create"] = (input) =>
      Effect.gen(function* () {
        const sdk = yield* getSdk;
        const sandbox = yield* Effect.tryPromise({
          try: () =>
            sdk.Sandbox.create({
              token: credentials.token,
              teamId: credentials.teamId,
              projectId: credentials.projectId,
              runtime: credentials.runtime ?? DEFAULT_RUNTIME,
              ports: [...input.ports],
              timeout: input.timeoutSeconds * 1_000,
              ...(input.resources?.cpu === undefined
                ? {}
                : { resources: { vcpus: input.resources.cpu } }),
              ...(input.snapshotId === null
                ? {}
                : { source: { type: "snapshot", snapshotId: input.snapshotId } }),
            }),
          catch: (cause) => fail("create", cause),
        });
        yield* rememberHandle(sandbox);

        const ports: ReadonlyArray<VercelSandboxPort> = input.ports.map((port) => ({
          port,
          url: resolveDomain(sandbox, port),
        }));
        return {
          sandboxId: sandbox.sandboxId,
          rootPath: SANDBOX_ROOT,
          ports,
        } satisfies VercelSandboxCreated;
      });

    const runCommandStreaming: VercelSandboxClientShape["runCommandStreaming"] = (
      sandboxId,
      input,
    ) =>
      Effect.gen(function* () {
        const sandbox = yield* requireSandbox("runCommandStreaming", sandboxId);
        const command = yield* Effect.tryPromise({
          try: () => sandbox.runCommand(runCommandInput(input, true)),
          catch: (cause) => fail("runCommandStreaming", cause),
        });
        if (!isDetachedCommand(command)) {
          return yield* Effect.fail(
            fail("runCommandStreaming", "detached runCommand did not return a streaming handle"),
          );
        }

        // Fan the structured log iterable into per-stream line queues. The SDK
        // yields chunks, not lines; split on newlines and buffer the partial tail
        // across chunks so a line split across two chunks is not mis-framed. The
        // queues end (not shutdown) on EOF so a `Stream.fromQueue` reader drains
        // to a clean completion instead of being interrupted.
        const stdoutQueue = yield* Queue.unbounded<string, Cause.Done<void>>();
        const stderrQueue = yield* Queue.unbounded<string, Cause.Done<void>>();
        const pumpScope = yield* Scope.make();

        const partials = { stdout: "", stderr: "" };
        const drainLog = (entry: VercelSdkLogEntry) =>
          Effect.gen(function* () {
            const queue = entry.stream === "stderr" ? stderrQueue : stdoutQueue;
            const buffered = partials[entry.stream] + logEntryText(entry);
            const segments = buffered.split(/\r?\n/);
            partials[entry.stream] = segments.pop() ?? "";
            for (const line of segments) {
              yield* Queue.offer(queue, line);
            }
          });

        const flushPartials = Effect.gen(function* () {
          for (const stream of ["stdout", "stderr"] as const) {
            const tail = partials[stream];
            if (tail.length > 0) {
              yield* Queue.offer(stream === "stderr" ? stderrQueue : stdoutQueue, tail);
              partials[stream] = "";
            }
          }
        });

        yield* Stream.fromAsyncIterable(command.logs(), (cause) => cause).pipe(
          Stream.runForEach(drainLog),
          Effect.ignore,
          Effect.flatMap(() => flushPartials),
          Effect.ensuring(Queue.end(stdoutQueue)),
          Effect.ensuring(Queue.end(stderrQueue)),
          Effect.forkIn(pumpScope),
        );

        const handle: VercelSandboxCommandHandle = {
          stdout: Stream.fromQueue(stdoutQueue),
          stderr: Stream.fromQueue(stderrQueue),
          writeStdin: (line) =>
            Effect.sync(() => {
              command.stdin?.write(`${line}\n`);
            }),
          exitCode: Effect.tryPromise(() => command.wait()).pipe(
            Effect.map((result): number | null => result.exitCode),
            Effect.orElseSucceed((): number | null => null),
          ),
          kill: Effect.tryPromise(() => command.kill()).pipe(
            Effect.ignore,
            Effect.flatMap(() => Scope.close(pumpScope, Exit.void)),
          ),
        };
        return handle;
      });

    const runCommandCollect: VercelSandboxClientShape["runCommandCollect"] = (sandboxId, input) =>
      Effect.gen(function* () {
        const sandbox = yield* requireSandbox("runCommandCollect", sandboxId);
        const command = yield* Effect.tryPromise({
          try: () => sandbox.runCommand(runCommandInput(input, false)),
          catch: (cause) => fail("runCommandCollect", cause),
        });
        if (isDetachedCommand(command)) {
          // Defensive: a blocking call should never hand back a detached handle,
          // but if it does, wait for completion and report no captured output.
          const finished = yield* Effect.tryPromise({
            try: () => command.wait(),
            catch: (cause) => fail("runCommandCollect", cause),
          });
          return {
            stdout: "",
            stderr: "",
            exitCode: finished.exitCode,
          } satisfies VercelSandboxCommandResult;
        }
        const [stdout, stderr] = yield* Effect.tryPromise({
          try: () => Promise.all([command.stdout(), command.stderr()]),
          catch: (cause) => fail("runCommandCollect", cause),
        });
        return {
          stdout,
          stderr,
          exitCode: command.exitCode,
        } satisfies VercelSandboxCommandResult;
      });

    const writeFile: VercelSandboxClientShape["writeFile"] = (sandboxId, path, contents) =>
      Effect.gen(function* () {
        const sandbox = yield* requireSandbox("writeFile", sandboxId);
        yield* Effect.tryPromise({
          try: () => sandbox.writeFiles([{ path, content: contents }]),
          catch: (cause) => fail("writeFile", cause),
        });
      });

    const readFile: VercelSandboxClientShape["readFile"] = (sandboxId, path) =>
      Effect.gen(function* () {
        const sandbox = yield* requireSandbox("readFile", sandboxId);
        return yield* Effect.tryPromise({
          try: () => sandbox.readFile({ path }).then(readFileToBytes),
          catch: (cause) => fail("readFile", cause),
        });
      });

    const getPortUrl: VercelSandboxClientShape["getPortUrl"] = (sandboxId, port) =>
      Effect.gen(function* () {
        const sandbox = yield* requireSandbox("getPortUrl", sandboxId);
        return yield* Effect.try({
          try: () => sandbox.domain(port),
          catch: (cause) =>
            fail("getPortUrl", `port ${port} is not exposed: ${redact(String(cause))}`),
        });
      });

    const snapshot: VercelSandboxClientShape["snapshot"] = (sandboxId) =>
      Effect.gen(function* () {
        const sandbox = yield* requireSandbox("snapshot", sandboxId);
        const result = yield* Effect.tryPromise({
          try: () => sandbox.createSnapshot(),
          catch: (cause) => fail("snapshot", cause),
        });
        return result.snapshotId;
      });

    const extendTimeout: VercelSandboxClientShape["extendTimeout"] = (
      sandboxId,
      additionalSeconds,
    ) =>
      Effect.gen(function* () {
        const sandbox = yield* requireSandbox("extendTimeout", sandboxId);
        const extend = sandbox.extendTimeout;
        if (extend === undefined) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => Promise.resolve(extend.call(sandbox, additionalSeconds * 1_000)),
          catch: (cause) => fail("extendTimeout", cause),
        });
      });

    // `isAlive` re-fetches the sandbox by id; a fetch failure means the provider
    // no longer reports it (lost/destroyed), so it is treated as not alive.
    const isAlive: VercelSandboxClientShape["isAlive"] = (sandboxId) =>
      reconnect(sandboxId).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    const forget = (sandboxId: VercelSandboxId) =>
      Ref.update(handles, (map) => {
        const next = new Map(map);
        next.delete(sandboxId);
        return next;
      });

    // Vercel sandboxes are ephemeral; `stop` ends the microVM and there is no
    // separate destroy. Both stop and destroy map to `stop()` and are idempotent.
    const stopSandbox = (sandboxId: VercelSandboxId) =>
      requireSandbox("stop", sandboxId).pipe(
        Effect.flatMap((sandbox) => Effect.tryPromise(() => sandbox.stop())),
        Effect.ignore,
        Effect.flatMap(() => forget(sandboxId)),
      );

    const stop: VercelSandboxClientShape["stop"] = stopSandbox;
    const destroy: VercelSandboxClientShape["destroy"] = stopSandbox;

    return {
      create,
      runCommandStreaming,
      runCommandCollect,
      writeFile,
      readFile,
      getPortUrl,
      snapshot,
      extendTimeout,
      isAlive,
      stop,
      destroy,
    } satisfies VercelSandboxClientShape;
  });

export const makeHttpVercelSandboxClientLive = (
  credentials: VercelSandboxCredentials,
  loadSdk?: VercelSandboxSdkLoader,
) => Layer.effect(VercelSandboxClient, makeHttpVercelSandboxClient(credentials, loadSdk));
