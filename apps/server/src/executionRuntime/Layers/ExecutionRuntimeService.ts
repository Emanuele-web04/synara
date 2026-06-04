/**
 * ExecutionRuntimeServiceLive - The orchestration-facing execution-runtime seam.
 *
 * For `local`/`worktree` threads this resolves nothing and provisions nothing:
 * it returns a compat target with no cwd override, so the reactor keeps its
 * existing local spawn path unchanged. For `remote-runtime` threads it resolves
 * a runtime adapter *by provider* through `RuntimeProviderRegistry`, provisions
 * an instance, and records the resolved facts (instance create, process
 * start/complete, destroy) through internal orchestration commands so runtime
 * state is event-sourced and survives reconnect. Stable per-thread/per-instance
 * command ids make reconnect/crash retries dedupe on the receipt rather than
 * re-appending.
 *
 * The service never names a concrete provider for its lifecycle calls: it routes
 * through `registry.getAdapter(provider)`. The only `fake`-specific knowledge it
 * still holds is the server-internal flavor bookkeeping standing in for a public
 * `runtimePlan` (no public plan carries a flavor), which the fake facade's
 * `deriveFakeFlavor` produces. The reactor sees only `ResolvedExecutionTarget`
 * and a `JsonRpcLineTransport`.
 *
 * @module ExecutionRuntimeServiceLive
 */
import {
  CommandId,
  ExecutionInstanceId,
  RuntimeProcessId,
  type ExecutionRuntimeProvider,
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
import { deriveFakeFlavor } from "./FakeRuntimeProviderFacade.ts";

const RUNNING_INSTANCE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "idle"]);

// When a remote thread is resolved after the in-memory flavor map is gone (a
// server restart between provision-request and provisioning), the read-model
// still says remote/`fake`. Fall back to a flavor that backs the agent role so
// the public remote path stays resilient across restart instead of failing.
const DEFAULT_FAKE_FLAVOR: FakeRuntimeFlavor = "fake-pty-workspace";

const runtimeCommandId = (threadId: ThreadId, suffix: string): CommandId =>
  CommandId.makeUnsafe(`runtime:${threadId}:${suffix}`);

// `markThreadRemote` carries a flavor but no public plan; synthesize the minimal
// plan the fake facade provisions from. The synthesized plan round-trips through
// `deriveFakeFlavor`, but the exact requested flavor is preserved in the
// per-thread/per-instance flavor maps so a non-pty/non-ephemeral flavor keeps
// its precise reconnect capability.
const planForFlavor = (flavor: FakeRuntimeFlavor): RuntimePlan => ({
  targetKind: "remote-runtime",
  provider: "fake",
  ports: [],
  persistent: flavor === "fake-pty-workspace" || flavor === "fake-command-workspace",
  snapshotId: null,
});

interface ProvisionIntent {
  readonly provider: ExecutionRuntimeProvider;
  readonly plan: RuntimePlan;
  /** Server-internal fake flavor, present only for the `fake` provider family. */
  readonly fakeFlavor?: FakeRuntimeFlavor;
}

const makeExecutionRuntimeService = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const planner = yield* ExecutionRuntimePlanner;
  const registry = yield* RuntimeProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // Per-thread provisioning intent, stashed at plan/mark time and read at
  // provision time (the wrinkle: plan derivation precedes provisioning). Stands
  // in for a public `runtimePlan` until a later slice exposes one; the read-model
  // only carries the public provider literal.
  const threadIntents = new Map<string, ProvisionIntent>();
  // Maps a provisioned instance id to the provider that backs it, so `exec`,
  // `destroy`, and `probeInstance` resolve the right adapter.
  const instanceProviders = new Map<string, ExecutionRuntimeProvider>();
  // Fake-only: maps a provisioned instance id to its exact flavor for the
  // flavor-specific reconnect-capability probe.
  const instanceFakeFlavors = new Map<string, FakeRuntimeFlavor>();

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

  const recordProvisionRequest = (
    threadId: ThreadId,
    provider: ExecutionRuntimeProvider,
    role: RuntimeRole,
  ) =>
    dispatchRuntimeCommand(threadId, "provision", (commandId, createdAt) => ({
      type: "thread.runtime.provision",
      commandId,
      threadId,
      targetKind: "remote-runtime",
      provider,
      role,
      createdAt,
    }));

  const markThreadRemote: ExecutionRuntimeServiceShape["markThreadRemote"] = (input) =>
    Effect.gen(function* () {
      const role: RuntimeRole = input.role ?? "agent";
      threadIntents.set(input.threadId, {
        provider: "fake",
        plan: planForFlavor(input.flavor),
        fakeFlavor: input.flavor,
      });
      yield* recordProvisionRequest(input.threadId, "fake", role);
    });

  const applyRuntimePlan: ExecutionRuntimeServiceShape["applyRuntimePlan"] = (input) =>
    Effect.gen(function* () {
      const plan = input.plan;
      // No plan, or a local/worktree plan, keeps the existing compat path: no
      // validation, no provisioning, no intent.
      if (plan == null || plan.targetKind !== "remote-runtime") {
        return;
      }
      const role: RuntimeRole = input.role ?? "agent";
      // Honor the plan's provider. The fake family validates against a
      // flavor-keyed descriptor (the public `fake` provider hides its flavor);
      // every other provider validates against its provider-keyed descriptor. A
      // provider with no registered descriptor fails `RuntimeProviderUnsupportedError`
      // here, pre-provision, which is correct until that provider lands.
      const isFake = plan.provider === "fake";
      const fakeFlavor = isFake ? deriveFakeFlavor(plan) : undefined;
      const descriptor = isFake
        ? yield* registry.getDescriptorByFlavor(fakeFlavor as FakeRuntimeFlavor)
        : yield* registry.getDescriptor(plan.provider);
      yield* planner.validateAgainstDescriptor(plan, role, descriptor);
      threadIntents.set(input.threadId, {
        provider: plan.provider,
        plan,
        ...(fakeFlavor !== undefined ? { fakeFlavor } : {}),
      });
      yield* recordProvisionRequest(input.threadId, plan.provider, role);
    });

  const provisionRemote = (
    threadId: ThreadId,
    targetKind: ExecutionTargetKind,
  ): Effect.Effect<ResolvedExecutionTarget, RuntimeProvisionFailedError> =>
    Effect.gen(function* () {
      const intent = threadIntents.get(threadId) ?? {
        provider: "fake" as ExecutionRuntimeProvider,
        plan: planForFlavor(DEFAULT_FAKE_FLAVOR),
        fakeFlavor: DEFAULT_FAKE_FLAVOR,
      };
      const adapter = yield* registry
        .getAdapter(intent.provider)
        .pipe(
          Effect.mapError((cause) => failProvision(threadId, `provision failed: ${cause.message}`)),
        );
      const context = yield* adapter
        .provision({ threadId, plan: intent.plan })
        .pipe(Effect.mapError((cause) => failProvision(threadId, `provision failed: ${cause}`)));
      instanceProviders.set(context.instance.id, intent.provider);
      if (intent.fakeFlavor !== undefined) {
        instanceFakeFlavors.set(context.instance.id, intent.fakeFlavor);
      }

      yield* dispatchRuntimeCommand(threadId, "instance.record", (commandId, createdAt) => ({
        type: "thread.runtime.instance.record",
        commandId,
        threadId,
        instanceId: context.instance.id,
        provider: intent.provider,
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
        const intent = threadIntents.get(threadId);
        instanceProviders.set(runtime.instance.id, runtime.instance.provider);
        if (intent?.fakeFlavor !== undefined) {
          instanceFakeFlavors.set(runtime.instance.id, intent.fakeFlavor);
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
      const provider = instanceProviders.get(input.instanceId);
      if (provider === undefined) {
        return yield* failProvision(
          input.threadId,
          `instance ${input.instanceId} is not a provisioned remote instance`,
        );
      }
      const adapter = yield* registry
        .getAdapter(provider)
        .pipe(
          Effect.mapError((cause) =>
            failProvision(input.threadId, `create transport failed: ${cause.message}`),
          ),
        );
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
      const built = yield* adapter
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
      const provider = instanceProviders.get(instanceId);
      if (provider !== undefined) {
        yield* registry.getAdapter(provider).pipe(
          Effect.flatMap((adapter) => adapter.destroy(instanceId)),
          Effect.ignore,
        );
      }
      instanceProviders.delete(instanceId);
      instanceFakeFlavors.delete(instanceId);
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
      const flavor = instanceFakeFlavors.get(instanceId);
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
      const alive = yield* registry.getAdapter("fake").pipe(
        Effect.flatMap((adapter) => adapter.isAlive(input.instanceId)),
        Effect.orElseSucceed(() => false),
      );
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
