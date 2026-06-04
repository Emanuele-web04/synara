/**
 * VercelSandboxAdapterLive - the Vercel Sandbox runtime adapter.
 *
 * Maps Vercel's command/log/file/preview-first sandbox onto the runtime-neutral
 * contracts the rest of the system consumes:
 *
 * - `provision` declares the plan's ports at create time (Vercel cannot add them
 *   later) and mints a `RuntimeInstanceSummary` rooted at the sandbox working dir.
 * - `createTransport` runs the agent as a *detached streaming* command (not a
 *   PTY) and forwards its log lines into an in-memory `JsonRpcLineTransport`, so
 *   Codex talks JSON-RPC over the sandbox's command/log channel with no PTY.
 * - `execCollect` is fire-and-collect, the primitive `RuntimeGitWorkspace` rides
 *   on for clone/seed/status/diff.
 * - `exposePort` resolves a declared port to its public preview URL.
 * - `snapshot` captures the otherwise-ephemeral filesystem.
 * - `extendTimeout` is the keepalive the activity lease drives.
 *
 * The adapter never persists raw credentials or logs tokenized URLs; every error
 * detail is redacted. It talks only to {@link VercelSandboxClient}, so it is
 * identical against the real provider and the in-memory fake.
 *
 * @module VercelSandboxAdapterLive
 */
import {
  ExecutionInstanceId,
  RuntimeRouteId,
  RuntimeSnapshotId,
  type RuntimeInstanceSummary,
  type RuntimePlan,
  type RuntimeRouteSummary,
  type RuntimeSnapshotSummary,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Layer, Ref, Scope, Stream } from "effect";

import {
  makeInMemoryJsonRpcTransport,
  type InMemoryTransportController,
  type JsonRpcLineTransport,
} from "../../../../provider/process/JsonRpcLineTransport.ts";
import { RuntimeInstanceUnknownError, RuntimeRemoteOperationFailedError } from "../../../Errors.ts";
import type { RuntimeProcessSpawnInput } from "../../../Services/RuntimeProcessTransport.ts";
import { redactSecrets } from "../../../Layers/redactCredentials.ts";
import { VercelSandboxAdapter } from "../Services/VercelSandboxAdapter.ts";
import { VercelSandboxClient, type VercelSandboxId } from "../Services/VercelSandboxClient.ts";

/** Seconds added to a sandbox's wall-clock timeout on each keepalive extend. */
export const VERCEL_SANDBOX_TIMEOUT_EXTEND_SECONDS = 300;
const DEFAULT_TIMEOUT_SECONDS = 1_800;

export interface VercelSandboxProvisionInput {
  readonly threadId: string;
  readonly plan: RuntimePlan;
}

export interface VercelSandboxInstanceContext {
  readonly instance: RuntimeInstanceSummary;
  readonly rootPath: string;
  readonly routes: ReadonlyArray<RuntimeRouteSummary>;
}

export interface VercelSandboxExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export interface VercelSandboxExecInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

export interface VercelSandboxAdapterShape {
  /** Provision a sandbox with the plan's ports declared up front. */
  readonly provision: (
    input: VercelSandboxProvisionInput,
  ) => Effect.Effect<VercelSandboxInstanceContext, RuntimeRemoteOperationFailedError>;
  /**
   * Run the agent as a detached streaming command behind an in-memory
   * `JsonRpcLineTransport`. The sandbox's log stream feeds inbound; outbound
   * JSON-RPC frames are written to the command's stdin. No PTY, no host pid.
   */
  readonly createTransport: (
    instanceId: ExecutionInstanceId,
    spawn: RuntimeProcessSpawnInput,
  ) => Effect.Effect<
    { readonly transport: JsonRpcLineTransport; readonly controller: InMemoryTransportController },
    RuntimeRemoteOperationFailedError
  >;
  /** Fire-and-collect command exec (the git/setup primitive). */
  readonly execCollect: (
    instanceId: ExecutionInstanceId,
    input: VercelSandboxExecInput,
  ) => Effect.Effect<VercelSandboxExecResult, RuntimeInstanceUnknownError>;
  /** Resolve a declared port to its public preview URL as a route summary. */
  readonly exposePort: (
    instanceId: ExecutionInstanceId,
    port: number,
  ) => Effect.Effect<RuntimeRouteSummary, RuntimeRemoteOperationFailedError>;
  /** Snapshot the (otherwise ephemeral) filesystem. */
  readonly snapshot: (
    instanceId: ExecutionInstanceId,
    label?: string | undefined,
  ) => Effect.Effect<RuntimeSnapshotSummary, RuntimeRemoteOperationFailedError>;
  /** Extend the sandbox timeout (the activity-lease keepalive). */
  readonly extendTimeout: (
    instanceId: ExecutionInstanceId,
  ) => Effect.Effect<void, RuntimeRemoteOperationFailedError>;
  /** Whether the provider still reports the sandbox as live (reconciler probe). */
  readonly isAlive: (instanceId: ExecutionInstanceId) => Effect.Effect<boolean>;
  /** Stop the sandbox without destroying it. Idempotent. */
  readonly stop: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
  /** Destroy the sandbox. Idempotent. */
  readonly destroy: (instanceId: ExecutionInstanceId) => Effect.Effect<void>;
}

/**
 * Forward a detached streaming sandbox command into an in-memory transport. The
 * sandbox's stdout lines feed `inbound`; outbound JSON-RPC frames the consumer
 * writes are relayed to the command's stdin; the command's exit resolves the
 * transport. Closing the transport kills the command. This is the command/log
 * analogue of a local stdio process — no PTY, no pid.
 */
const forwardDetachedCommand = (
  controller: InMemoryTransportController,
  transport: JsonRpcLineTransport,
  client: VercelSandboxClient["Service"],
  sandboxId: VercelSandboxId,
  spawn: RuntimeProcessSpawnInput,
): Effect.Effect<void, RuntimeRemoteOperationFailedError> =>
  Effect.gen(function* () {
    const forwardScope = yield* Scope.make();
    const handle = yield* client
      .runCommandStreaming(sandboxId, {
        command: spawn.command,
        args: spawn.args,
        cwd: spawn.cwd,
        env: spawn.env,
        detached: true,
      })
      .pipe(Effect.tapError(() => Scope.close(forwardScope, Exit.void)));

    // Record the command's exit status as soon as it is known. This resolves the
    // transport's `exit` deferred (the consumer's liveness/await signal) without
    // ending the inbound stream — that happens on stdout EOF below.
    yield* handle.exitCode.pipe(
      Effect.flatMap((code) => controller.signalExit({ code, signal: null })),
      Effect.forkIn(forwardScope),
    );

    yield* handle.stderr.pipe(
      Stream.runForEach((line) => controller.pushStderr(line)),
      Effect.ignore,
      Effect.forkIn(forwardScope),
    );

    // Relay each outbound frame the consumer writes to the command's stdin. The
    // single-element take repeats forever; when the consumer's outbound queue
    // ends on transport close, the take fails with `Cause.Done`, ending it.
    yield* Stream.fromEffect(controller.takeOutbound).pipe(
      Stream.forever,
      Stream.runForEach((line) => handle.writeStdin(line)),
      Effect.ignore,
      Effect.forkIn(forwardScope),
    );

    // Forward stdout log lines as inbound JSON-RPC frames. When stdout reaches
    // EOF (the command's output is done) the transport is closed, ending the
    // inbound/stderr queues so a consumer draining `inbound` to completion sees a
    // clean EOF instead of hanging — an in-memory transport's queues only end on
    // close. Closing also tears the command scope down.
    yield* handle.stdout.pipe(
      Stream.runForEach((line) => controller.pushInbound(line)),
      Effect.ignore,
      Effect.flatMap(() => transport.close),
      Effect.flatMap(() => handle.kill),
      Effect.flatMap(() => Scope.close(forwardScope, Exit.void)),
      Effect.forkDetach,
    );

    // A consumer-initiated close also kills the command and tears the scope down.
    yield* Deferred.await(transport.exit).pipe(
      Effect.flatMap(() => handle.kill),
      Effect.flatMap(() => Scope.close(forwardScope, Exit.void)),
      Effect.forkDetach,
    );
  });

const makeVercelSandboxAdapter = Effect.gen(function* () {
  const client = yield* VercelSandboxClient;
  // Maps our `ExecutionInstanceId` to the provider's native sandbox id + root.
  const sandboxes = yield* Ref.make(
    new Map<string, { readonly sandboxId: VercelSandboxId; readonly rootPath: string }>(),
  );

  const requireSandbox = (instanceId: ExecutionInstanceId) =>
    Ref.get(sandboxes).pipe(Effect.map((map) => map.get(String(instanceId))));

  const provision: VercelSandboxAdapterShape["provision"] = (input) =>
    Effect.gen(function* () {
      const plan = input.plan;
      const created = yield* client.create({
        ports: plan.ports ?? [],
        timeoutSeconds: plan.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        snapshotId: plan.snapshotId ?? null,
        ...(plan.resources === undefined
          ? {}
          : {
              resources: {
                cpu: plan.resources.cpu,
                memoryMb: plan.resources.memoryMb,
              },
            }),
      });

      const instanceId = ExecutionInstanceId.makeUnsafe(`vercel-${created.sandboxId}`);
      yield* Ref.update(sandboxes, (map) => {
        const next = new Map(map);
        next.set(String(instanceId), {
          sandboxId: created.sandboxId,
          rootPath: created.rootPath,
        });
        return next;
      });

      const now = new Date().toISOString();
      const routes: ReadonlyArray<RuntimeRouteSummary> = created.ports.map((entry) => ({
        id: RuntimeRouteId.makeUnsafe(`route-${created.sandboxId}-${entry.port}`),
        port: entry.port,
        url: entry.url,
        label: null,
        exposedAt: now,
      }));
      const instance: RuntimeInstanceSummary = {
        id: instanceId,
        provider: "vercel-sandbox",
        status: "running",
        rootPath: created.rootPath,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      return { instance, rootPath: created.rootPath, routes };
    });

  const createTransport: VercelSandboxAdapterShape["createTransport"] = (instanceId, spawn) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox(instanceId);
      if (sandbox === undefined) {
        return yield* Effect.fail(
          new RuntimeRemoteOperationFailedError({
            provider: "vercel-sandbox",
            operation: "createTransport",
            detail: `unknown instance ${instanceId}`,
          }),
        );
      }
      const built = yield* makeInMemoryJsonRpcTransport();
      yield* forwardDetachedCommand(
        built.controller,
        built.transport,
        client,
        sandbox.sandboxId,
        spawn,
      );
      return { transport: built.transport, controller: built.controller };
    });

  const execCollect: VercelSandboxAdapterShape["execCollect"] = (instanceId, input) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox(instanceId);
      if (sandbox === undefined) {
        return yield* Effect.fail(
          new RuntimeInstanceUnknownError({ instanceId: String(instanceId) }),
        );
      }
      const result = yield* client
        .runCommandCollect(sandbox.sandboxId, {
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          detached: false,
        })
        .pipe(
          // A provider-level failure becomes a 127 command result so the git
          // boundary classifies it like any other non-zero exit. The detail is
          // redacted of credential material first.
          Effect.catch((error) =>
            Effect.succeed({
              stdout: "",
              stderr: redactSecrets(error.detail, []),
              exitCode: 127,
            }),
          ),
        );
      return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
    });

  const exposePort: VercelSandboxAdapterShape["exposePort"] = (instanceId, port) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox(instanceId);
      if (sandbox === undefined) {
        return yield* Effect.fail(
          new RuntimeRemoteOperationFailedError({
            provider: "vercel-sandbox",
            operation: "exposePort",
            detail: `unknown instance ${instanceId}`,
          }),
        );
      }
      const url = yield* client.getPortUrl(sandbox.sandboxId, port);
      return {
        id: RuntimeRouteId.makeUnsafe(`route-${sandbox.sandboxId}-${port}`),
        port,
        url,
        label: null,
        exposedAt: new Date().toISOString(),
      } satisfies RuntimeRouteSummary;
    });

  const snapshot: VercelSandboxAdapterShape["snapshot"] = (instanceId, label) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox(instanceId);
      if (sandbox === undefined) {
        return yield* Effect.fail(
          new RuntimeRemoteOperationFailedError({
            provider: "vercel-sandbox",
            operation: "snapshot",
            detail: `unknown instance ${instanceId}`,
          }),
        );
      }
      const snapshotId = yield* client.snapshot(sandbox.sandboxId);
      return {
        id: RuntimeSnapshotId.makeUnsafe(snapshotId),
        label: label ?? null,
        // A snapshot taken while credentials may be present in the filesystem is
        // conservatively flagged secret-tainted (the credential broker's rule).
        secretTainted: true,
        createdAt: new Date().toISOString(),
      } satisfies RuntimeSnapshotSummary;
    });

  const extendTimeout: VercelSandboxAdapterShape["extendTimeout"] = (instanceId) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox(instanceId);
      if (sandbox === undefined) {
        return yield* Effect.fail(
          new RuntimeRemoteOperationFailedError({
            provider: "vercel-sandbox",
            operation: "extendTimeout",
            detail: `unknown instance ${instanceId}`,
          }),
        );
      }
      yield* client.extendTimeout(sandbox.sandboxId, VERCEL_SANDBOX_TIMEOUT_EXTEND_SECONDS);
    });

  const isAlive: VercelSandboxAdapterShape["isAlive"] = (instanceId) =>
    requireSandbox(instanceId).pipe(
      Effect.flatMap((sandbox) =>
        sandbox === undefined ? Effect.succeed(false) : client.isAlive(sandbox.sandboxId),
      ),
    );

  const stop: VercelSandboxAdapterShape["stop"] = (instanceId) =>
    requireSandbox(instanceId).pipe(
      Effect.flatMap((sandbox) =>
        sandbox === undefined ? Effect.void : client.stop(sandbox.sandboxId),
      ),
    );

  const destroy: VercelSandboxAdapterShape["destroy"] = (instanceId) =>
    Effect.gen(function* () {
      const sandbox = yield* requireSandbox(instanceId);
      if (sandbox === undefined) {
        return;
      }
      yield* Ref.update(sandboxes, (map) => {
        const next = new Map(map);
        next.delete(String(instanceId));
        return next;
      });
      yield* client.destroy(sandbox.sandboxId);
    });

  return {
    provision,
    createTransport,
    execCollect,
    exposePort,
    snapshot,
    extendTimeout,
    isAlive,
    stop,
    destroy,
  } satisfies VercelSandboxAdapterShape;
});

export const VercelSandboxAdapterLive = Layer.effect(
  VercelSandboxAdapter,
  makeVercelSandboxAdapter,
);
