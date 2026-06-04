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

export interface DaytonaProvisionInput {
  readonly threadId: string;
  readonly ports: ReadonlyArray<number>;
  readonly snapshotId: string | null;
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
    { readonly transport: JsonRpcLineTransport; readonly controller: InMemoryTransportController },
    DaytonaApiError
  >;
  /** Fire-and-collect command exec (git rides this). */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: DaytonaExecInput,
  ) => Effect.Effect<DaytonaExecResult, DaytonaApiError>;
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

const makeDaytonaRuntimeAdapter = Effect.gen(function* () {
  const client = yield* DaytonaSandboxClient;
  // Sandbox id is the durable provider id; the contract `ExecutionInstanceId` is
  // the same string, so reconnect after restart works off the persisted id alone.
  const sandboxRoots = new Map<string, string>();

  // Discover the sandbox's real working dir by polling `pwd`. It is image-
  // dependent (a snapshot may run as root at /root, the default image at
  // /home/daytona, ...), so a hardcoded root breaks `cd` for the agent process.
  // The retry doubles as the readiness wait: exec errors until the sandbox is
  // running. Falls back to the client's rootPath if discovery never succeeds.
  const discoverRoot = (sandboxId: string, fallback: string): Effect.Effect<string> => {
    const attempt = (remaining: number): Effect.Effect<string> =>
      client.exec(sandboxId, { command: "pwd", args: [] }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0 && result.stdout.trim().startsWith("/")
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(
                new DaytonaApiError({
                  operation: "provision",
                  status: null,
                  detail: "sandbox not ready",
                }),
              ),
        ),
        Effect.catch(() =>
          remaining <= 0
            ? Effect.succeed(fallback)
            : Effect.sleep("2 seconds").pipe(Effect.flatMap(() => attempt(remaining - 1))),
        ),
      );
    return attempt(40);
  };

  const provision: DaytonaRuntimeAdapterShape["provision"] = (input) =>
    Effect.gen(function* () {
      const sandbox = yield* client.create({
        threadId: input.threadId,
        ports: input.ports,
        snapshotId: input.snapshotId,
      });
      const rootPath = yield* discoverRoot(sandbox.id, sandbox.rootPath);
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
          new DaytonaApiError({ operation: "execCollect", status: null, detail: error.message }),
        ),
      ),
    );

  const exposePort: DaytonaRuntimeAdapterShape["exposePort"] = (instanceId, port) =>
    client
      .exposePort(String(instanceId), port)
      .pipe(
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({ operation: "exposePort", status: null, detail: error.message }),
          ),
        ),
      );

  const snapshot: DaytonaRuntimeAdapterShape["snapshot"] = (instanceId, label) =>
    client
      .snapshot(String(instanceId), label)
      .pipe(
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({ operation: "snapshot", status: null, detail: error.message }),
          ),
        ),
      );

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
    client
      .stop(String(instanceId))
      .pipe(
        Effect.catchTag("DaytonaSandboxUnknownError", (error) =>
          Effect.fail(
            new DaytonaApiError({ operation: "stop", status: null, detail: error.message }),
          ),
        ),
      );

  const isAlive: DaytonaRuntimeAdapterShape["isAlive"] = (instanceId) =>
    client.getStatus(String(instanceId)).pipe(
      Effect.map((sandbox) => sandbox !== null && sandbox.status === "running"),
      Effect.orElseSucceed(() => false),
    );

  const destroy: DaytonaRuntimeAdapterShape["destroy"] = (instanceId) =>
    Effect.sync(() => sandboxRoots.delete(String(instanceId))).pipe(
      Effect.flatMap(() => client.destroy(String(instanceId))),
      Effect.ignore,
    );

  return {
    provision,
    createTransport,
    execCollect,
    exposePort,
    snapshot,
    refreshActivity,
    stop,
    isAlive,
    destroy,
  } satisfies DaytonaRuntimeAdapterShape;
});

export const makeDaytonaRuntimeAdapterEffect = makeDaytonaRuntimeAdapter;

export const DaytonaRuntimeAdapterLive = Layer.effect(
  DaytonaRuntimeAdapter,
  makeDaytonaRuntimeAdapter,
);
