import { readFile } from "node:fs/promises";

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Result,
  Semaphore,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createOpencodeClient, type Agent, type OpencodeClient } from "@opencode-ai/sdk/v2";

import { NetService } from "@t3tools/shared/Net";
import { isWindowsShellCommandMissingResult } from "../shell-command-detection.ts";
import {
  DEFAULT_HOSTNAME,
  DEFAULT_OPENCODE_SERVER_TIMEOUT_MS,
  OPENCODE_CLI_SPEC,
  OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
  OpenCodeRuntimeError,
  buildOpenCodeServerProcessEnv,
  collectStreamAsString,
  ensureRuntimeError,
  formatOpenCodeServerStartupDetail,
  openCodeRuntimeErrorDetail,
  parseOpenCodeCliModelsOutput,
  parseOpenCodeCredentialProviderIDs,
  parseServerUrlFromOutput,
  pooledOpenCodeServerKey,
  redactStartupOutput,
  resolveOpenCodeAuthFilePath,
  runOpenCodeSdk,
  supportsVerboseModelsCommandFailure,
  toListModelsCommandError,
  type OpenCodeCommandResult,
  type OpenCodeCompatibleCliSpec,
  type OpenCodePathInfo,
  type OpenCodeRuntimeShape,
  type OpenCodeServerProcess,
} from "./opencodeRuntime.helpers.ts";

export * from "./opencodeRuntime.helpers.ts";

interface PooledOpenCodeServer {
  readonly key: string;
  readonly server: OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  refCount: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
  exitWatchFiber: Fiber.Fiber<void, never> | null;
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService;
  const pooledServerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const pooledServerMutex = yield* Semaphore.make(1);
  const pooledServers = new Map<string, PooledOpenCodeServer>();

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.binaryPath, [...input.args], {
          shell: process.platform === "win32",
          env: process.env,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (isWindowsShellCommandMissingResult({ code: exitCode, stderr })) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.Scope;
      const cliSpec = input.cliSpec ?? OPENCODE_CLI_SPEC;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", "--hostname", hostname, "--port", String(port)];

      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.binaryPath, args, {
            env: buildOpenCodeServerProcessEnv({
              cliSpec,
              ...(input.experimentalWebSockets !== undefined
                ? { experimentalWebSockets: input.experimentalWebSockets }
                : {}),
            }),
            detached: false,
            killSignal: "SIGKILL",
            forceKillAfter: "1500 millis",
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );
      yield* Scope.addFinalizer(
        runtimeScope,
        child.kill({ killSignal: "SIGKILL", forceKillAfter: "1500 millis" }).pipe(Effect.ignore),
      );

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseServerUrlFromOutput(nextStdout, cliSpec.serverReadyPrefix);
            return parsed
              ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
              : Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = redactStartupOutput(yield* Ref.get(stdoutRef));
            const stderr = redactStartupOutput(yield* Ref.get(stderrRef));
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: formatOpenCodeServerStartupDetail({
                  displayName: cliSpec.displayName,
                  summary: `${cliSpec.displayName} server exited before startup completed (code: ${String(exitCode)}).`,
                  binaryPath: input.binaryPath,
                  args,
                  readyPrefix: cliSpec.serverReadyPrefix,
                  stdout,
                  stderr,
                }),
                cause: {
                  exitCode,
                  stdout,
                  stderr,
                  binaryPath: input.binaryPath,
                  args,
                  readyPrefix: cliSpec.serverReadyPrefix,
                },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          [
            `Failed while waiting for ${cliSpec.displayName} server startup:`,
            openCodeRuntimeErrorDetail(squashed),
          ].join(" "),
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const stdout = redactStartupOutput(yield* Ref.get(stdoutRef));
        const stderr = redactStartupOutput(yield* Ref.get(stderrRef));
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: formatOpenCodeServerStartupDetail({
            displayName: cliSpec.displayName,
            summary: `Timed out waiting for ${cliSpec.displayName} server start after ${timeoutMs}ms.`,
            binaryPath: input.binaryPath,
            args,
            readyPrefix: cliSpec.serverReadyPrefix,
            stdout,
            stderr,
          }),
          cause: {
            timeoutMs,
            stdout,
            stderr,
            binaryPath: input.binaryPath,
            args,
            readyPrefix: cliSpec.serverReadyPrefix,
          },
        });
      }

      return {
        url: readyOption.value,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const cancelPooledServerIdleClose = Effect.fn("cancelPooledServerIdleClose")(function* (
    pooledServer: PooledOpenCodeServer,
  ) {
    const idleCloseFiber = pooledServer.idleCloseFiber;
    pooledServer.idleCloseFiber = null;
    if (idleCloseFiber !== null) {
      yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
    }
  });

  const detachPooledServer = Effect.fn("detachPooledServer")(function* (
    pooledServer: PooledOpenCodeServer,
  ) {
    pooledServers.delete(pooledServer.key);
    pooledServer.refCount = 0;
    yield* cancelPooledServerIdleClose(pooledServer);
  });

  const closePooledServer = Effect.fn("closePooledServer")(function* (
    pooledServer: PooledOpenCodeServer,
  ) {
    yield* detachPooledServer(pooledServer);

    const exitWatchFiber = pooledServer.exitWatchFiber;
    pooledServer.exitWatchFiber = null;
    if (exitWatchFiber !== null) {
      yield* Fiber.interrupt(exitWatchFiber).pipe(Effect.ignore);
    }

    yield* Scope.close(pooledServer.scope, Exit.void).pipe(Effect.ignore);
  });

  const schedulePooledServerIdleClose = Effect.fn("schedulePooledServerIdleClose")(function* (
    pooledServer: PooledOpenCodeServer,
  ) {
    yield* cancelPooledServerIdleClose(pooledServer);
    const idleCloseFiber = yield* Effect.sleep(OPENCODE_LOCAL_SERVER_IDLE_TTL_MS).pipe(
      Effect.andThen(
        pooledServerMutex.withPermit(
          Effect.gen(function* () {
            if (pooledServers.get(pooledServer.key) !== pooledServer || pooledServer.refCount > 0) {
              return;
            }
            pooledServer.idleCloseFiber = null;
            yield* closePooledServer(pooledServer);
          }),
        ),
      ),
      Effect.forkIn(pooledServerScope),
    );
    pooledServer.idleCloseFiber = idleCloseFiber;
  });

  const watchPooledServerExit = Effect.fn("watchPooledServerExit")(function* (
    pooledServer: PooledOpenCodeServer,
  ) {
    const exitWatchFiber = yield* pooledServer.server.exitCode.pipe(
      Effect.flatMap(() =>
        pooledServerMutex.withPermit(
          Effect.gen(function* () {
            if (pooledServers.get(pooledServer.key) !== pooledServer) {
              return;
            }
            pooledServer.exitWatchFiber = null;
            yield* detachPooledServer(pooledServer);
            yield* Scope.close(pooledServer.scope, Exit.void).pipe(Effect.ignore);
          }),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(pooledServerScope),
    );
    pooledServer.exitWatchFiber = exitWatchFiber;
  });

  const acquirePooledServer = (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
    readonly experimentalWebSockets?: boolean;
  }) =>
    pooledServerMutex.withPermit(
      Effect.gen(function* () {
        const key = pooledOpenCodeServerKey(input);
        const existing = pooledServers.get(key);
        if (existing) {
          yield* cancelPooledServerIdleClose(existing);
          existing.refCount += 1;
          return existing;
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              restore(
                startOpenCodeServerProcess(input).pipe(
                  Effect.provideService(Scope.Scope, serverScope),
                ),
              ),
            );

            if (Exit.isFailure(startedExit)) {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            const pooledServer: PooledOpenCodeServer = {
              key,
              server: startedExit.value,
              scope: serverScope,
              refCount: 1,
              idleCloseFiber: null,
              exitWatchFiber: null,
            };
            pooledServers.set(key, pooledServer);
            yield* watchPooledServerExit(pooledServer);
            return pooledServer;
          }),
        );
      }),
    );

  const releasePooledServer = (pooledServer: PooledOpenCodeServer) =>
    pooledServerMutex.withPermit(
      Effect.gen(function* () {
        if (pooledServers.get(pooledServer.key) !== pooledServer) {
          return;
        }
        pooledServer.refCount = Math.max(0, pooledServer.refCount - 1);
        if (pooledServer.refCount === 0) {
          yield* schedulePooledServerIdleClose(pooledServer);
        }
      }),
    );

  yield* Effect.addFinalizer(() =>
    pooledServerMutex.withPermit(
      Effect.gen(function* () {
        for (const pooledServer of Array.from(pooledServers.values())) {
          yield* closePooledServer(pooledServer);
        }
      }),
    ),
  );

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      return Effect.succeed({
        url: serverUrl,
        exitCode: null,
        external: true,
      });
    }

    return Effect.gen(function* () {
      const callerScope = yield* Scope.Scope;
      const pooledServer = yield* acquirePooledServer({
        binaryPath: input.binaryPath,
        ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.experimentalWebSockets !== undefined
          ? { experimentalWebSockets: input.experimentalWebSockets }
          : {}),
      });
      yield* Scope.addFinalizer(callerScope, releasePooledServer(pooledServer));
      return {
        url: pooledServer.server.url,
        exitCode: pooledServer.server.exitCode,
        external: false,
      };
    });
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`${(input.cliSpec ?? OPENCODE_CLI_SPEC).serverAuthUsername}:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", () => client.provider.list()).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", () => client.app.agents()).pipe(
      Effect.map((result) => result.data ?? []),
    );

  const loadOptionalAgents = (client: OpencodeClient) =>
    loadAgents(client).pipe(
      Effect.timeoutOption("2 seconds"),
      Effect.map(Option.getOrElse((): ReadonlyArray<Agent> => [])),
      Effect.catch((cause) =>
        Effect.logDebug("OpenCode agent discovery skipped", {
          reason: openCodeRuntimeErrorDetail(cause),
        }).pipe(Effect.as([] as ReadonlyArray<Agent>)),
      ),
    );

  const loadConsoleState = (client: OpencodeClient) =>
    runOpenCodeSdk("experimental.console.get", () => client.experimental.console.get()).pipe(
      Effect.map((result) => result.data ?? null),
      // Console metadata is optional and should not block model discovery.
      Effect.catch(() => Effect.succeed(null)),
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadOptionalAgents(client), loadConsoleState(client)], {
      concurrency: "unbounded",
    }).pipe(
      Effect.map(([providerList, agents, consoleState]) => ({
        providerList,
        agents,
        consoleState,
      })),
    );

  const loadOpenCodePaths = (client: OpencodeClient) =>
    runOpenCodeSdk("path.get", () => client.path.get()).pipe(
      Effect.filterMapOrFail(
        (response) =>
          response.data
            ? Result.succeed(response.data as OpenCodePathInfo)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "path.get",
                  detail: "OpenCode path.get returned no path payload.",
                }),
              ),
        (result) => result,
      ),
    );

  const listOpenCodeCliModelsFromArgs = (input: {
    readonly binaryPath: string;
    readonly cliSpec?: OpenCodeCompatibleCliSpec;
    readonly args: ReadonlyArray<string>;
  }) =>
    runOpenCodeCommand({
      binaryPath: input.binaryPath,
      ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
      args: input.args,
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(parseOpenCodeCliModelsOutput(result.stdout))
          : Effect.fail(
              toListModelsCommandError({
                binaryPath: input.binaryPath,
                args: input.args,
                stdout: result.stdout,
                stderr: result.stderr,
                code: result.code,
              }),
            ),
      ),
    );

  const listOpenCodeCliModels: OpenCodeRuntimeShape["listOpenCodeCliModels"] = (input) =>
    listOpenCodeCliModelsFromArgs({
      binaryPath: input.binaryPath,
      ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
      args: ["models", "--verbose"],
    }).pipe(
      Effect.catch((error) => {
        if (!OpenCodeRuntimeError.is(error)) {
          return Effect.fail(error);
        }

        const cause = error.cause as
          | {
              readonly stdout?: string;
              readonly stderr?: string;
            }
          | undefined;
        if (
          !supportsVerboseModelsCommandFailure(cause?.stdout ?? "", cause?.stderr ?? "") &&
          !supportsVerboseModelsCommandFailure("", error.detail)
        ) {
          return Effect.fail(error);
        }

        return listOpenCodeCliModelsFromArgs({
          binaryPath: input.binaryPath,
          ...(input.cliSpec !== undefined ? { cliSpec: input.cliSpec } : {}),
          args: ["models"],
        });
      }),
    );

  const loadOpenCodeCredentialProviderIDs: OpenCodeRuntimeShape["loadOpenCodeCredentialProviderIDs"] =
    (client, cliSpec = OPENCODE_CLI_SPEC) =>
      loadOpenCodePaths(client).pipe(
        Effect.flatMap((pathInfo) =>
          Effect.tryPromise({
            try: () => readFile(resolveOpenCodeAuthFilePath(pathInfo, cliSpec), "utf8"),
            catch: (cause) =>
              new OpenCodeRuntimeError({
                operation: "readOpenCodeCredentialProviderIDs",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          }),
        ),
        Effect.flatMap((content) =>
          Effect.try({
            try: () => parseOpenCodeCredentialProviderIDs(content),
            catch: (cause) =>
              new OpenCodeRuntimeError({
                operation: "parseOpenCodeCredentialProviderIDs",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          }),
        ),
        // Explicit credential metadata is optional. Discovery should still work when
        // the auth file does not exist, is unreadable, or belongs to another machine.
        Effect.catch(() => Effect.succeed([])),
      );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    listOpenCodeCliModels,
    loadOpenCodeCredentialProviderIDs,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends ServiceMap.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
