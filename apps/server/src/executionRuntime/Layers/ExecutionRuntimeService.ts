/**
 * ExecutionRuntimeServiceLive - The orchestration-facing execution-runtime seam.
 *
 * For `local`/`worktree` threads this resolves nothing and provisions nothing:
 * it returns a compat target with no cwd override, so the reactor keeps its
 * existing local spawn path unchanged. For `remote-runtime` threads it routes to
 * the fake adapter, provisions an instance rooted in a temp dir, and records the
 * resolved facts (instance create, process start/complete, destroy) through
 * internal orchestration commands so runtime state is event-sourced and survives
 * reconnect. Stable per-thread/per-instance command ids make reconnect/crash
 * retries dedupe on the receipt rather than re-appending.
 *
 * Provider-specifics (the fake adapter, flavors, temp dirs) live entirely here.
 * The reactor sees only `ResolvedExecutionTarget` and a `JsonRpcLineTransport`.
 *
 * @module ExecutionRuntimeServiceLive
 */
import {
  CommandId,
  ExecutionInstanceId,
  RuntimeProcessId,
  type ExecutionTargetKind,
  type RuntimePlan,
  type RuntimeRole,
  type ThreadId,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { JsonRpcLineTransport } from "../../provider/process/JsonRpcLineTransport.ts";
import { RuntimeProvisionFailedError } from "../Errors.ts";
import { ExecutionRuntimePlanner } from "../Services/ExecutionRuntimePlanner.ts";
import { type FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import { RuntimeProviderRegistry } from "../Services/RuntimeProviderRegistry.ts";
import {
  ExecutionRuntimeService,
  type ExecutionRuntimeServiceShape,
  type ResolvedExecutionTarget,
} from "../Services/ExecutionRuntimeService.ts";
import { FakeRuntimeProviderAdapter } from "../Services/FakeRuntimeProviderAdapter.ts";

/**
 * Pick the server-internal fake flavor a public `RuntimePlan` maps to. The
 * public `fake` provider hides flavor; we choose by the plan's persistence
 * intent. A persistent (or snapshot-backed) plan lands on the pty-workspace
 * flavor, which backs every role, ports, persistence, and snapshots. A
 * non-persistent plan lands on the throwaway ephemeral flavor, which exposes no
 * ports and no snapshots — so a non-persistent plan that still asks for ports or
 * a snapshot is genuinely unsupported and the planner rejects it pre-provision.
 */
const deriveFakeFlavor = (plan: RuntimePlan): FakeRuntimeFlavor =>
  plan.persistent === true || plan.snapshotId != null
    ? "fake-pty-workspace"
    : "fake-ephemeral-runtime";

const RUNNING_INSTANCE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "idle"]);

// When a remote thread is resolved after the in-memory flavor map is gone (a
// server restart between provision-request and provisioning), the read-model
// still says remote/`fake`. Fall back to a flavor that backs the agent role so
// the public remote path stays resilient across restart instead of failing.
const DEFAULT_FAKE_FLAVOR: FakeRuntimeFlavor = "fake-pty-workspace";

const runtimeCommandId = (threadId: ThreadId, suffix: string): CommandId =>
  CommandId.makeUnsafe(`runtime:${threadId}:${suffix}`);

const makeExecutionRuntimeService = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const fakeAdapter = yield* FakeRuntimeProviderAdapter;
  const planner = yield* ExecutionRuntimePlanner;
  const registry = yield* RuntimeProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // Server-internal flavor registration standing in for a public `runtimePlan`.
  // Provisioning reads this to pick the fake flavor before it routes to the
  // adapter; the read-model only carries the public `fake` provider.
  const threadFlavors = new Map<string, FakeRuntimeFlavor>();
  // Maps a provisioned instance id back to its flavor for `createTransport`.
  const instanceFlavors = new Map<string, FakeRuntimeFlavor>();

  const failProvision = (threadId: ThreadId, detail: string) =>
    new RuntimeProvisionFailedError({ threadId, detail });

  const dispatchRuntimeCommand = (
    threadId: ThreadId,
    suffix: string,
    build: (commandId: CommandId, createdAt: string) => Parameters<typeof engine.dispatch>[0],
  ) => {
    const commandId = runtimeCommandId(threadId, suffix);
    const createdAt = new Date().toISOString();
    return engine.dispatch(build(commandId, createdAt)).pipe(
      Effect.mapError((error) =>
        failProvision(threadId, `dispatch ${suffix} failed: ${error.message}`),
      ),
      Effect.asVoid,
    );
  };

  // A failed projection read is treated as "no runtime row": the thread falls
  // back to the local compat path rather than failing provisioning outright.
  const resolveThreadRuntime = (threadId: ThreadId) =>
    snapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map((option) => Option.getOrUndefined(option)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const markThreadRemote: ExecutionRuntimeServiceShape["markThreadRemote"] = (input) =>
    Effect.gen(function* () {
      const role: RuntimeRole = input.role ?? "agent";
      threadFlavors.set(input.threadId, input.flavor);
      yield* dispatchRuntimeCommand(input.threadId, "provision", (commandId, createdAt) => ({
        type: "thread.runtime.provision",
        commandId,
        threadId: input.threadId,
        targetKind: "remote-runtime",
        provider: "fake",
        role,
        createdAt,
      }));
    });

  const applyRuntimePlan: ExecutionRuntimeServiceShape["applyRuntimePlan"] = (input) =>
    Effect.gen(function* () {
      const plan = input.plan;
      // No plan, or a local/worktree plan, keeps the existing compat path: no
      // validation, no provisioning, no flavor.
      if (plan == null || plan.targetKind !== "remote-runtime") {
        return;
      }
      const role: RuntimeRole = input.role ?? "agent";
      const flavor = deriveFakeFlavor(plan);
      // Validate against the flavor's descriptor before any provisioning, so an
      // unsupported plan/role combination is rejected pre-provision.
      const descriptor = yield* registry.getDescriptorByFlavor(flavor);
      yield* planner.validateAgainstDescriptor(plan, role, descriptor);
      yield* markThreadRemote({ threadId: input.threadId, flavor, role });
    });

  const provisionRemote = (
    threadId: ThreadId,
    targetKind: ExecutionTargetKind,
  ): Effect.Effect<ResolvedExecutionTarget, RuntimeProvisionFailedError> =>
    Effect.gen(function* () {
      const flavor = threadFlavors.get(threadId) ?? DEFAULT_FAKE_FLAVOR;
      const context = yield* fakeAdapter
        .provision({ threadId, flavor })
        .pipe(Effect.mapError((cause) => failProvision(threadId, `provision failed: ${cause}`)));
      instanceFlavors.set(context.instance.id, flavor);

      yield* dispatchRuntimeCommand(threadId, "instance.record", (commandId, createdAt) => ({
        type: "thread.runtime.instance.record",
        commandId,
        threadId,
        instanceId: context.instance.id,
        provider: "fake",
        status: "running",
        rootPath: context.rootPath,
        createdAt,
      }));

      return {
        threadId,
        targetKind,
        cwd: context.rootPath,
        instanceId: context.instance.id,
      } satisfies ResolvedExecutionTarget;
    });

  const ensureTargetForThread: ExecutionRuntimeServiceShape["ensureTargetForThread"] = (threadId) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadRuntime(threadId);
      const runtime = thread?.runtime ?? null;
      const targetKind: ExecutionTargetKind = runtime?.targetKind ?? "local";

      // Compat path: local/worktree threads keep the reactor's existing cwd
      // resolution. No provisioning, no cwd override, no instance.
      if (targetKind !== "remote-runtime") {
        return {
          threadId,
          targetKind,
          cwd: undefined,
          instanceId: null,
        } satisfies ResolvedExecutionTarget;
      }

      // Reuse an already-running instance rather than re-provisioning.
      if (
        runtime?.instance !== null &&
        runtime?.instance !== undefined &&
        RUNNING_INSTANCE_STATUSES.has(runtime.instance.status)
      ) {
        const flavor = threadFlavors.get(threadId);
        if (flavor !== undefined) {
          instanceFlavors.set(runtime.instance.id, flavor);
        }
        return {
          threadId,
          targetKind,
          cwd: runtime.instance.rootPath ?? undefined,
          instanceId: runtime.instance.id,
        } satisfies ResolvedExecutionTarget;
      }

      return yield* provisionRemote(threadId, targetKind);
    });

  const exec: ExecutionRuntimeServiceShape["exec"] = (input) =>
    Effect.gen(function* () {
      const flavor = instanceFlavors.get(input.instanceId);
      if (flavor === undefined) {
        return yield* failProvision(
          input.threadId,
          `instance ${input.instanceId} is not a provisioned fake instance`,
        );
      }
      const processId = RuntimeProcessId.makeUnsafe(`proc-${crypto.randomUUID()}`);

      yield* dispatchRuntimeCommand(
        input.threadId,
        `process.start.${processId}`,
        (commandId, createdAt) => ({
          type: "thread.runtime.process.start",
          commandId,
          threadId: input.threadId,
          instanceId: input.instanceId,
          processId,
          role: input.role,
          command: input.command.trim().length > 0 ? input.command : null,
          createdAt,
        }),
      );

      const cwd = (yield* resolveThreadRuntime(input.threadId))?.runtime?.instance?.rootPath ?? ".";
      const built = yield* fakeAdapter
        .createTransport(input.instanceId, {
          command: input.command,
          args: input.args,
          cwd,
          env: input.env ?? {},
        })
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) =>
            failProvision(input.threadId, `create transport failed: ${cause}`),
          ),
        );

      // Record completion + exit code when the process exits. Stream-only output
      // is not event-sourced (resolved decision #5); the lifecycle + exit is.
      yield* Effect.forkDetach(
        Deferred.await(built.transport.exit).pipe(
          Effect.flatMap((status) =>
            dispatchRuntimeCommand(
              input.threadId,
              `process.complete.${processId}`,
              (commandId, createdAt) => ({
                type: "thread.runtime.process.complete",
                commandId,
                threadId: input.threadId,
                instanceId: input.instanceId,
                processId,
                status: status.code === 0 || status.code === null ? "exited" : "failed",
                exitCode: status.code,
                createdAt,
              }),
            ),
          ),
          Effect.ignore,
        ),
      );

      return {
        processId,
        transport: built.transport,
        controller: built.controller,
      };
    });

  const destroy: ExecutionRuntimeServiceShape["destroy"] = (threadId, instanceId) =>
    Effect.gen(function* () {
      yield* fakeAdapter.destroy(instanceId).pipe(Effect.ignore);
      instanceFlavors.delete(instanceId);
      yield* dispatchRuntimeCommand(threadId, "destroy", (commandId, createdAt) => ({
        type: "thread.runtime.destroy",
        commandId,
        threadId,
        instanceId,
        createdAt,
      })).pipe(Effect.ignore);
    });

  // Resolve the reconnect capability for a fake instance. A flavor recorded in
  // the in-memory map (provisioned this process lifetime) gives the precise
  // descriptor; otherwise the family default is reconnect-capable, and liveness
  // (`isAlive`) decides the rest. Provider knowledge stays here, not the reactor.
  const resolveFakeReconnect = (instanceId: ExecutionInstanceId) =>
    Effect.gen(function* () {
      const flavor = instanceFlavors.get(instanceId);
      if (flavor === undefined) {
        return true;
      }
      const descriptor = yield* registry
        .getDescriptorByFlavor(flavor)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      return descriptor?.capabilities.lifecycle.reconnect ?? true;
    });

  const probeInstance: ExecutionRuntimeServiceShape["probeInstance"] = (input) =>
    Effect.gen(function* () {
      // Only the fake provider family has a concrete adapter in this slice. Other
      // providers resolve their reconnect capability from the registry; with no
      // adapter to probe they report `absent`, so the reconciler marks them lost.
      if (input.provider !== "fake") {
        const descriptor = yield* registry
          .getDescriptor(input.provider)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return {
          supportsReconnect: descriptor?.capabilities.lifecycle.reconnect ?? false,
          liveness: "absent" as const,
        };
      }
      const supportsReconnect = yield* resolveFakeReconnect(input.instanceId);
      const alive = yield* fakeAdapter
        .isAlive(input.instanceId)
        .pipe(Effect.orElseSucceed(() => false));
      return {
        supportsReconnect,
        liveness: alive ? ("alive" as const) : ("absent" as const),
      };
    });

  const recordInstanceState: ExecutionRuntimeServiceShape["recordInstanceState"] = (input) =>
    dispatchRuntimeCommand(
      input.threadId,
      `state.${input.status}.${input.instanceId}`,
      (commandId, createdAt) => ({
        type: "thread.runtime.state.record",
        commandId,
        threadId: input.threadId,
        instanceId: input.instanceId,
        status: input.status,
        ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
        createdAt,
      }),
    );

  return {
    markThreadRemote,
    applyRuntimePlan,
    ensureTargetForThread,
    exec,
    destroy,
    probeInstance,
    recordInstanceState,
  } satisfies ExecutionRuntimeServiceShape;
});

export const ExecutionRuntimeServiceLive = Layer.effect(
  ExecutionRuntimeService,
  makeExecutionRuntimeService,
);

export type { JsonRpcLineTransport };
