/**
 * Modal provider contract test.
 *
 * The shared Phase-17 baseline {@link describeRuntimeProviderContract} always
 * runs against the *fake* command backend (local temp dirs + real local
 * processes), so the baseline passes in CI with no provider access — this is the
 * green gate. The real Modal CLI backend is exercised only when opted in via
 * `MODAL_CONTRACT_LIVE=1` plus the `MODAL_TOKEN_*` credentials, keeping live-API
 * calls off the default CI path. Both paths run the identical contract; only the
 * backing command backend differs.
 *
 * The contract provisions the `service` role — the broadest Modal shape and the
 * one the shared registry binds for the `modal` provider — so ingress-capable
 * git/exec/transport behavior is what the baseline asserts.
 *
 * @module modal/ModalRuntimeAdapter.contract.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionInstanceId, RuntimePlan, type RuntimeRole } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { ExecutionRuntimePlannerLive } from "../../Layers/ExecutionRuntimePlanner.ts";
import { makeRuntimeProviderRegistryLive } from "../../Layers/RuntimeProviderRegistry.ts";
import { ExecutionRuntimePlanner } from "../../Services/ExecutionRuntimePlanner.ts";
import {
  describeRuntimeProviderContract,
  type ContractExecResult,
  type ContractInstance,
  type ContractTransport,
  type RuntimeProviderUnderTest,
} from "../contract/describeRuntimeProviderContract.ts";
import { MODAL_PROVIDER_DESCRIPTOR } from "./modalDescriptors.ts";
import { resolveModalCredentials } from "./ModalCredentials.ts";
import { ModalRuntimeProviderAdapter } from "./ModalRuntimeProviderAdapter.ts";
import { makeModalRuntimeAdapterLayer } from "./runtimeLayer.ts";

const decodePlan = Schema.decodeUnknownSync(RuntimePlan);

const registryLayer = makeRuntimeProviderRegistryLive({
  descriptors: [MODAL_PROVIDER_DESCRIPTOR],
});

// Modal's exec/transport ops declare `ChildProcessSpawner` in their requirement
// channel (the fake/real backends spawn local processes), unlike the
// Daytona/Vercel adapters whose exec is fully self-contained. The shared harness
// runs every op against one runtime, so the spawner joins the provider services;
// `NodeServices.layer` supplies it.
type ProviderServices =
  | ModalRuntimeProviderAdapter
  | ExecutionRuntimePlanner
  | ChildProcessSpawner.ChildProcessSpawner;

interface ProviderMode {
  /** When set, resolve credentials from this env; `{}` forces the fake backend. */
  readonly env: Record<string, string | undefined>;
}

const makeModalProvider = (mode: ProviderMode): RuntimeProviderUnderTest<ProviderServices> => {
  const layer = Layer.mergeAll(
    makeModalRuntimeAdapterLayer({ env: mode.env }),
    ExecutionRuntimePlannerLive.pipe(Layer.provide(registryLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const runtime = ManagedRuntime.make(layer);

  const provision = (
    threadId: string,
  ): Effect.Effect<ContractInstance, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* ModalRuntimeProviderAdapter;
      const context = yield* adapter.provision({ threadId, role: "service" });
      return { instanceId: context.instance.id, rootPath: context.rootPath };
    });

  const exec = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractExecResult, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* ModalRuntimeProviderAdapter;
      return yield* adapter.execCollect(instanceId, { command, args });
    });

  const createTransport = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractTransport, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* ModalRuntimeProviderAdapter;
      // The service process runs with the (fake) backend's environment; pass the
      // host env so the interpreter resolves on PATH, mirroring how a real Modal
      // sandbox carries its own PATH for the agent process.
      return yield* adapter.createTransport(instanceId, {
        command,
        args,
        cwd: ".",
        env: process.env,
      });
    });

  const isAlive = (
    instanceId: ExecutionInstanceId,
  ): Effect.Effect<boolean, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* ModalRuntimeProviderAdapter;
      return yield* adapter.isAlive(instanceId);
    });

  const destroy = (
    instanceId: ExecutionInstanceId,
  ): Effect.Effect<void, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* ModalRuntimeProviderAdapter;
      yield* adapter.destroy(instanceId);
    });

  const validatePlanForRole = (
    role: RuntimeRole,
  ): Effect.Effect<unknown, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      return yield* planner.validate(
        decodePlan({ targetKind: "remote-runtime", provider: "modal" }),
        role,
      );
    });

  return {
    descriptor: MODAL_PROVIDER_DESCRIPTOR,
    runtime,
    provision,
    exec,
    createTransport,
    isAlive,
    destroy,
    validatePlanForRole,
  };
};

// Baseline: always fake-backed. An empty env forces the fake backend regardless
// of any `MODAL_TOKEN_*` in the ambient shell — this is the green CI gate.
describeRuntimeProviderContract("modal (fake)", () => makeModalProvider({ env: {} }));

// Live: opt-in only. Requires both the explicit flag and real credentials so a
// stray token in a dev shell never triggers live-API calls in a normal test run.
const liveEnabled =
  process.env.MODAL_CONTRACT_LIVE === "1" && resolveModalCredentials(process.env) !== null;
if (liveEnabled) {
  describeRuntimeProviderContract("modal (live)", () => makeModalProvider({ env: process.env }));
}
