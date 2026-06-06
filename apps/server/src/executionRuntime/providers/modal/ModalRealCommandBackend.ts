/**
 * ModalRealCommandBackend - The credentialed Modal command transport.
 *
 * Selected only when {@link resolveModalCredentials} finds `MODAL_TOKEN_ID` /
 * `MODAL_TOKEN_SECRET`. It routes commands through the Modal CLI rather than a
 * local shell: a verification job is a `modal` invocation whose stdout/stderr is
 * the job's log stream and whose exit code is the terminal `Finished` result.
 *
 * The wiring reuses the in-memory transport forwarding the fake backend uses —
 * the only difference is which process is spawned (the `modal` CLI vs. the user
 * command directly) and which working dir / env carries the Modal credentials.
 * Modal exposes no PTY and no addressable per-exec process id, so this never
 * claims one.
 *
 * Ingress is real where Modal supports it: when an instance carries a live Modal
 * sandbox id, {@link exposePort} loads the `modal` JS SDK
 * ({@link loadModalSdk}) and resolves the port's encrypted tunnel to its public
 * `*.modal.run` URL via `sandbox.tunnels()`. The CLI exec/transport staging path
 * does not yet mint a live sandbox id (the agent runs against a local checkout
 * synced into the sandbox), so for those instances `exposePort` honestly reports
 * a null url rather than synthesizing one that would not route. Associating a
 * real sandbox id with a provisioned instance is the remaining live-Modal step;
 * the SDK tunnel resolution beneath it is real.
 *
 * The exec/transport path has no automated coverage against a live Modal account
 * (no creds in CI); the contract suite exercises the fake backend. The SDK tunnel
 * resolution is unit-tested against a stub SDK so the real code path is covered
 * without the network or the optional dependency installed.
 *
 * @module ModalRealCommandBackend
 */
import nodePath from "node:path";
import { tmpdir } from "node:os";

import { ExecutionInstanceId } from "@t3tools/contracts";
import { Deferred, Effect, Exit, FileSystem, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../../stream/collectUint8StreamText.ts";
import {
  makeInMemoryJsonRpcTransport,
  type InMemoryTransportController,
  type JsonRpcLineTransport,
} from "../../../provider/process/JsonRpcLineTransport.ts";
import { redactSecrets } from "../../Layers/redactCredentials.ts";
import type { ModalCredentials } from "./ModalCredentials.ts";
import type {
  ModalCommandTransportShape,
  ModalExecResult,
  ModalProcessSpawnInput,
} from "./ModalCommandTransport.ts";
import { loadModalSdk, type ModalSdkClient, type ModalSdkLoader } from "./modalSdk.ts";

const encoder = new TextEncoder();

const MODAL_CLI = "modal";

/** Build the env a Modal CLI invocation runs with, carrying the credentials. */
const modalEnv = (
  credentials: ModalCredentials,
  base: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> => ({
  ...base,
  MODAL_TOKEN_ID: credentials.tokenId,
  MODAL_TOKEN_SECRET: credentials.tokenSecret,
  ...(credentials.environment === undefined ? {} : { MODAL_ENVIRONMENT: credentials.environment }),
});

const forwardModalProcess = (
  credentials: ModalCredentials,
  controller: InMemoryTransportController,
  transport: JsonRpcLineTransport,
  spawn: ModalProcessSpawnInput,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const forwardScope = yield* Scope.make();

    const spawned = yield* spawner
      .spawn(
        ChildProcess.make(MODAL_CLI, ["shell", "--cmd", [spawn.command, ...spawn.args].join(" ")], {
          cwd: spawn.cwd,
          env: modalEnv(credentials, spawn.env),
        }),
      )
      .pipe(Effect.provideService(Scope.Scope, forwardScope), Effect.exit);

    if (Exit.isFailure(spawned)) {
      yield* controller.signalExit({ code: 127, signal: null });
      yield* Scope.close(forwardScope, Exit.void);
      return;
    }
    const child = spawned.value;

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => controller.pushInbound(line)),
      Effect.ignore,
      Effect.forkIn(forwardScope),
    );
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => controller.pushStderr(line)),
      Effect.ignore,
      Effect.forkIn(forwardScope),
    );
    const outboundToStdin = Stream.fromEffect(controller.takeOutbound).pipe(
      Stream.forever,
      Stream.map((line) => encoder.encode(`${line}\n`)),
      Stream.run(child.stdin),
    );
    yield* outboundToStdin.pipe(Effect.ignore, Effect.forkIn(forwardScope));
    yield* child.exitCode.pipe(
      Effect.matchCause({
        onSuccess: (code) => ({ code: Number(code), signal: null }),
        onFailure: () => ({ code: null, signal: null }),
      }),
      Effect.flatMap((status) => controller.signalExit(status)),
      Effect.forkIn(forwardScope),
    );
    yield* Deferred.await(transport.exit).pipe(
      Effect.flatMap(() => Scope.close(forwardScope, Exit.void)),
      Effect.forkDetach,
    );
  });

export interface ModalRealCommandBackend extends ModalCommandTransportShape {
  readonly backendKind: "real";
  /**
   * Associate a live Modal sandbox id with a provisioned instance so ingress
   * resolves its real tunnel. The CLI staging path does not mint a live sandbox;
   * this is the seam the live-Modal provisioning step calls once it does. A no-op
   * for an unknown instance.
   */
  readonly attachSandbox: (
    instanceId: ExecutionInstanceId,
    sandboxId: string,
  ) => Effect.Effect<void>;
}

export interface ModalRealCommandBackendOptions {
  /**
   * Override the `modal` SDK loader (tests supply a stub so the real ingress
   * path runs without the optional dependency installed or a network call).
   */
  readonly loadSdk?: ModalSdkLoader;
}

/** Per-instance state the real backend tracks. */
interface ModalInstanceRecord {
  /** Local staging dir holding the checkout the job runs against. */
  readonly root: string;
  /**
   * The live Modal sandbox id backing this instance, when one exists. Null for
   * the CLI staging path (which mints no live sandbox), so ingress honestly
   * reports a null url rather than synthesizing one.
   */
  readonly sandboxId: string | null;
}

export const makeModalRealCommandBackend = (
  credentials: ModalCredentials,
  options?: ModalRealCommandBackendOptions,
): Effect.Effect<ModalRealCommandBackend, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const records = new Map<ExecutionInstanceId, ModalInstanceRecord>();
    const loadSdk = options?.loadSdk ?? loadModalSdk;
    const secrets = [credentials.tokenId, credentials.tokenSecret];
    const redact = (value: string): string => redactSecrets(value, secrets);

    // Load the optional SDK lazily and once. Deferring keeps the backend
    // infallible to build (its error channel stays `never`, unifying with the
    // fake); the ingress path fails loudly on first use if the package is
    // missing rather than silently degrading.
    const getClient = yield* Effect.cached(
      Effect.tryPromise({
        try: async (): Promise<ModalSdkClient> => {
          const sdk = await loadSdk();
          return sdk.makeClient({
            tokenId: credentials.tokenId,
            tokenSecret: credentials.tokenSecret,
            ...(credentials.environment === undefined
              ? {}
              : { environment: credentials.environment }),
          });
        },
        catch: (cause) => new Error(redact(cause instanceof Error ? cause.message : String(cause))),
      }),
    );

    const provision: ModalCommandTransportShape["provision"] = (input) =>
      Effect.gen(function* () {
        const instanceId = ExecutionInstanceId.makeUnsafe(`modal-${crypto.randomUUID()}`);
        // A local staging dir holds the checkout the job runs against before it
        // is synced into the Modal sandbox.
        const root = nodePath.join(tmpdir(), "synara-modal-stage", String(instanceId));
        yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
        records.set(instanceId, { root, sandboxId: null });
        return { instanceId, rootPath: root, role: input.role };
      });

    const resolveCwd = (root: string, cwd: string | undefined): string =>
      cwd === undefined || cwd.length === 0 ? root : nodePath.resolve(root, cwd);

    const execCollect: ModalCommandTransportShape["execCollect"] = (instanceId, input) =>
      Effect.gen(function* () {
        const record = records.get(instanceId);
        if (record === undefined) {
          return {
            stdout: "",
            stderr: `modal: no such instance ${String(instanceId)}`,
            code: 127,
          } satisfies ModalExecResult;
        }
        const root = record.root;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawned = yield* spawner
          .spawn(
            ChildProcess.make(
              MODAL_CLI,
              ["shell", "--cmd", [input.command, ...input.args].join(" ")],
              {
                cwd: resolveCwd(root, input.cwd),
                env: modalEnv(credentials, input.env),
              },
            ),
          )
          .pipe(Effect.exit);
        if (Exit.isFailure(spawned)) {
          return {
            stdout: "",
            stderr: `failed to invoke ${MODAL_CLI}`,
            code: 127,
          } satisfies ModalExecResult;
        }
        const child = spawned.value;
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout }).pipe(
              Effect.orElseSucceed(() => ({ text: "", truncated: false })),
            ),
            collectUint8StreamText({ stream: child.stderr }).pipe(
              Effect.orElseSucceed(() => ({ text: "", truncated: false })),
            ),
            child.exitCode.pipe(
              Effect.map((value): number | null => Number(value)),
              Effect.orElseSucceed((): number | null => null),
            ),
          ],
          { concurrency: "unbounded" },
        );
        return { stdout: stdout.text, stderr: stderr.text, code } satisfies ModalExecResult;
      }).pipe(Effect.scoped);

    const createTransport: ModalCommandTransportShape["createTransport"] = (_instanceId, spawn) =>
      Effect.gen(function* () {
        const built = yield* makeInMemoryJsonRpcTransport();
        if (spawn.command.trim().length > 0) {
          yield* forwardModalProcess(credentials, built.controller, built.transport, spawn);
        }
        return { transport: built.transport, controller: built.controller };
      });

    // Resolve a live sandbox's encrypted tunnel for a port via the SDK. Modal
    // keys tunnels by the container port they forward to; the URL is the public
    // `https://<sandbox-id>.modal.run` endpoint. A lookup/tunnel failure yields a
    // null url so the caller surfaces a pending route rather than an error.
    const resolveTunnelUrl = (sandboxId: string, port: number): Effect.Effect<string | null> =>
      getClient.pipe(
        Effect.flatMap((client) =>
          Effect.tryPromise(async () => {
            const sandbox = await client.sandboxes.fromId(sandboxId);
            const tunnels = await sandbox.tunnels();
            const tunnel = tunnels[port];
            return tunnel === undefined ? null : tunnel.url();
          }),
        ),
        Effect.orElseSucceed(() => null),
      );

    const exposePort: ModalCommandTransportShape["exposePort"] = (instanceId, port) =>
      Effect.suspend(() => {
        const record = records.get(instanceId);
        // No instance, or an instance with no live sandbox (the CLI staging
        // path): honestly report a pending (null) url — synthesizing a
        // `*.modal.run` URL that would not route would be a lie.
        if (record === undefined || record.sandboxId === null) {
          return Effect.succeed({ port, url: null });
        }
        return resolveTunnelUrl(record.sandboxId, port).pipe(Effect.map((url) => ({ port, url })));
      });

    const attachSandbox: ModalRealCommandBackend["attachSandbox"] = (instanceId, sandboxId) =>
      Effect.sync(() => {
        const record = records.get(instanceId);
        if (record === undefined) {
          return;
        }
        records.set(instanceId, { root: record.root, sandboxId });
      });

    const isAlive: ModalCommandTransportShape["isAlive"] = (instanceId) =>
      Effect.sync(() => records.has(instanceId));

    const destroy: ModalCommandTransportShape["destroy"] = (instanceId) =>
      Effect.gen(function* () {
        const record = records.get(instanceId);
        if (record === undefined) {
          return;
        }
        records.delete(instanceId);
        yield* fs.remove(record.root, { recursive: true }).pipe(Effect.ignore);
      });

    return {
      backendKind: "real",
      provision,
      execCollect,
      createTransport,
      exposePort,
      attachSandbox,
      isAlive,
      destroy,
    } satisfies ModalRealCommandBackend;
  });
