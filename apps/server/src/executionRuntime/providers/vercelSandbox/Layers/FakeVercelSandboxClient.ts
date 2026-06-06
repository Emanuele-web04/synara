/**
 * FakeVercelSandboxClient - an in-memory stand-in for the Vercel Sandbox API.
 *
 * It honors the same {@link VercelSandboxClient} contract the real client does,
 * but backs each sandbox with a local temp dir and runs commands as local child
 * processes. This is what the contract tests run against when no Vercel
 * credentials are present, so the command/log/file/preview/snapshot/timeout
 * paths are exercised in CI without touching the provider. It deliberately
 * reproduces the provider's quirks: ports must be declared at create (an
 * undeclared port has no URL), the filesystem is ephemeral (destroy removes it),
 * and snapshots are the only way state survives a destroy.
 *
 * @module FakeVercelSandboxClient
 */
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, Exit, FileSystem, Layer, Ref, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../../../stream/collectUint8StreamText.ts";
import { RuntimeRemoteOperationFailedError } from "../../../Errors.ts";
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

const PORT_URL_HOST = "fake-sandbox.vercel.app";

interface FakeSandbox {
  readonly rootPath: string;
  /** Snapshot dirs this sandbox restored from / wrote to, by snapshot id. */
  readonly ports: ReadonlyArray<number>;
  timeoutSeconds: number;
  alive: boolean;
}

const fail = (operation: string, detail: string) =>
  new RuntimeRemoteOperationFailedError({ provider: "vercel-sandbox", operation, detail });

const portUrl = (sandboxId: string, port: number): string =>
  `https://${sandboxId}-${port}.${PORT_URL_HOST}`;

const resolveCwd = (root: string, cwd: string | undefined): string =>
  cwd === undefined || cwd.length === 0 ? root : nodePath.resolve(root, cwd);

/**
 * Resolve the spawn `env` option. The fake runs commands locally, so it inherits
 * this host's environment (most importantly `PATH`) and layers the caller's
 * overrides on top. An empty/undefined override means "inherit" rather than
 * "wipe" — passing `{}` to a child process replaces the whole environment, which
 * would strip `PATH` and break `node`/`git`.
 */
const resolveEnv = (
  env: Record<string, string | undefined> | undefined,
): { readonly env?: Record<string, string | undefined> } => {
  if (env === undefined || Object.keys(env).length === 0) {
    return {};
  }
  return { env: { ...process.env, ...env } };
};

/**
 * Build the fake client. Sandboxes live in an in-process map keyed by a minted
 * id; their filesystems live under the OS temp dir. A snapshot copies the
 * sandbox dir to a sibling snapshot dir so a later create can restore it.
 */
const makeClient = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const sandboxes = yield* Ref.make(new Map<VercelSandboxId, FakeSandbox>());
  const snapshots = yield* Ref.make(new Map<string, string>());

  const requireSandbox = (operation: string, sandboxId: VercelSandboxId) =>
    Ref.get(sandboxes).pipe(
      Effect.flatMap((map) => {
        const sandbox = map.get(sandboxId);
        if (sandbox === undefined || !sandbox.alive) {
          return Effect.fail(fail(operation, `unknown sandbox ${sandboxId}`));
        }
        return Effect.succeed(sandbox);
      }),
    );

  const create: VercelSandboxClientShape["create"] = (input) =>
    Effect.gen(function* () {
      const sandboxId = `vsbx-${crypto.randomUUID()}`;
      const root = nodePath.join(tmpdir(), "synara-vercel-sandbox", sandboxId);
      yield* fileSystem
        .makeDirectory(root, { recursive: true })
        .pipe(Effect.mapError((cause) => fail("create", `makeDirectory: ${cause}`)));

      // Restore from a snapshot by copying its tree into the new root.
      if (input.snapshotId !== null) {
        const snapshotPath = yield* Ref.get(snapshots).pipe(
          Effect.map((map) => map.get(input.snapshotId as string)),
        );
        if (snapshotPath === undefined) {
          return yield* Effect.fail(fail("create", `unknown snapshot ${input.snapshotId}`));
        }
        yield* fileSystem
          .copy(snapshotPath, root, { overwrite: true })
          .pipe(Effect.mapError((cause) => fail("create", `restore snapshot: ${cause}`)));
      }

      const sandbox: FakeSandbox = {
        rootPath: root,
        ports: [...input.ports],
        timeoutSeconds: input.timeoutSeconds,
        alive: true,
      };
      yield* Ref.update(sandboxes, (map) => {
        const next = new Map(map);
        next.set(sandboxId, sandbox);
        return next;
      });

      const ports: ReadonlyArray<VercelSandboxPort> = input.ports.map((port) => ({
        port,
        url: portUrl(sandboxId, port),
      }));
      return { sandboxId, rootPath: root, ports } satisfies VercelSandboxCreated;
    });

  const spawnInSandbox = (
    operation: string,
    sandboxId: VercelSandboxId,
    input: VercelSandboxCommandInput,
    scope: Scope.Scope,
  ) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox(operation, sandboxId);
      const cwd = resolveCwd(sandbox.rootPath, input.cwd);
      return yield* spawner
        .spawn(ChildProcess.make(input.command, [...input.args], { cwd, ...resolveEnv(input.env) }))
        .pipe(Effect.provideService(Scope.Scope, scope));
    });

  const runCommandStreaming: VercelSandboxClientShape["runCommandStreaming"] = (sandboxId, input) =>
    Effect.gen(function* () {
      const commandScope = yield* Scope.make();
      const child = yield* spawnInSandbox(
        "runCommandStreaming",
        sandboxId,
        input,
        commandScope,
      ).pipe(
        Effect.tapError(() => Scope.close(commandScope, Exit.void)),
        Effect.mapError((cause) =>
          cause instanceof RuntimeRemoteOperationFailedError
            ? cause
            : fail("runCommandStreaming", `spawn ${input.command}: ${cause}`),
        ),
      );

      const encoder = new TextEncoder();
      const handle: VercelSandboxCommandHandle = {
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.orDie),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.splitLines, Stream.orDie),
        writeStdin: (line) =>
          Stream.make(encoder.encode(`${line}\n`)).pipe(Stream.run(child.stdin), Effect.ignore),
        exitCode: child.exitCode.pipe(
          Effect.map((code): number | null => Number(code)),
          Effect.orElseSucceed((): number | null => null),
        ),
        kill: Scope.close(commandScope, Exit.void),
      };
      return handle;
    });

  const runCommandCollect: VercelSandboxClientShape["runCommandCollect"] = (sandboxId, input) =>
    Effect.gen(function* () {
      // An unknown sandbox is a provider fault and propagates as a tagged error.
      const sandbox = yield* requireSandbox("runCommandCollect", sandboxId);
      const cwd = resolveCwd(sandbox.rootPath, input.cwd);
      const commandScope = yield* Scope.make();

      // A spawn failure (e.g. a missing binary) is a command-level result, not a
      // provider fault: surface it as a 127 exit so the git boundary classifies
      // it like any other non-zero exit.
      const spawned = yield* spawner
        .spawn(ChildProcess.make(input.command, [...input.args], { cwd, ...resolveEnv(input.env) }))
        .pipe(Effect.provideService(Scope.Scope, commandScope), Effect.exit);

      if (Exit.isFailure(spawned)) {
        yield* Scope.close(commandScope, Exit.void);
        return {
          stdout: "",
          stderr: `failed to spawn ${input.command}`,
          exitCode: 127,
        } satisfies VercelSandboxCommandResult;
      }
      const proc = spawned.value;

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: proc.stdout }).pipe(
            Effect.orElseSucceed(() => ({ text: "", truncated: false })),
          ),
          collectUint8StreamText({ stream: proc.stderr }).pipe(
            Effect.orElseSucceed(() => ({ text: "", truncated: false })),
          ),
          proc.exitCode.pipe(
            Effect.map((code): number | null => Number(code)),
            Effect.orElseSucceed((): number | null => null),
          ),
        ],
        { concurrency: "unbounded" },
      );
      yield* Scope.close(commandScope, Exit.void);
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
      } satisfies VercelSandboxCommandResult;
    });

  const writeFile: VercelSandboxClientShape["writeFile"] = (sandboxId, path, contents) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox("writeFile", sandboxId);
      const target = nodePath.resolve(sandbox.rootPath, path);
      yield* fileSystem
        .makeDirectory(nodePath.dirname(target), { recursive: true })
        .pipe(Effect.mapError((cause) => fail("writeFile", `mkdir: ${cause}`)));
      yield* fileSystem
        .writeFile(target, contents)
        .pipe(Effect.mapError((cause) => fail("writeFile", `write ${path}: ${cause}`)));
    });

  const readFile: VercelSandboxClientShape["readFile"] = (sandboxId, path) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox("readFile", sandboxId);
      const target = nodePath.resolve(sandbox.rootPath, path);
      return yield* fileSystem
        .readFile(target)
        .pipe(Effect.mapError((cause) => fail("readFile", `read ${path}: ${cause}`)));
    });

  const getPortUrl: VercelSandboxClientShape["getPortUrl"] = (sandboxId, port) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox("getPortUrl", sandboxId);
      if (!sandbox.ports.includes(port)) {
        return yield* Effect.fail(
          fail("getPortUrl", `port ${port} was not declared at create time`),
        );
      }
      return portUrl(sandboxId, port);
    });

  const snapshot: VercelSandboxClientShape["snapshot"] = (sandboxId) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox("snapshot", sandboxId);
      const snapshotId = `vsnap-${crypto.randomUUID()}`;
      const snapshotPath = nodePath.join(tmpdir(), "synara-vercel-sandbox-snapshots", snapshotId);
      yield* fileSystem
        .copy(sandbox.rootPath, snapshotPath, { overwrite: true })
        .pipe(Effect.mapError((cause) => fail("snapshot", `copy: ${cause}`)));
      yield* Ref.update(snapshots, (map) => {
        const next = new Map(map);
        next.set(snapshotId, snapshotPath);
        return next;
      });
      return snapshotId;
    });

  const extendTimeout: VercelSandboxClientShape["extendTimeout"] = (sandboxId, additionalSeconds) =>
    requireSandbox("extendTimeout", sandboxId).pipe(
      Effect.flatMap((sandbox) =>
        Effect.sync(() => {
          sandbox.timeoutSeconds += additionalSeconds;
        }),
      ),
    );

  const isAlive: VercelSandboxClientShape["isAlive"] = (sandboxId) =>
    Ref.get(sandboxes).pipe(Effect.map((map) => map.get(sandboxId)?.alive === true));

  const stop: VercelSandboxClientShape["stop"] = (sandboxId) =>
    Ref.update(sandboxes, (map) => {
      const sandbox = map.get(sandboxId);
      if (sandbox === undefined) {
        return map;
      }
      const next = new Map(map);
      next.set(sandboxId, { ...sandbox, alive: false });
      return next;
    });

  const destroy: VercelSandboxClientShape["destroy"] = (sandboxId) =>
    Effect.gen(function* () {
      const sandbox = yield* Ref.get(sandboxes).pipe(Effect.map((map) => map.get(sandboxId)));
      if (sandbox === undefined) {
        return;
      }
      yield* Ref.update(sandboxes, (map) => {
        const next = new Map(map);
        next.delete(sandboxId);
        return next;
      });
      yield* fileSystem.remove(sandbox.rootPath, { recursive: true }).pipe(Effect.ignore);
    });

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

export const FakeVercelSandboxClientLive = Layer.effect(VercelSandboxClient, makeClient);
