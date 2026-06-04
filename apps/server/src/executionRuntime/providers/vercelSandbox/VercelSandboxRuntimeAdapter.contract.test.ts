/**
 * Vercel Sandbox provider contract test.
 *
 * The shared Phase-17 baseline {@link describeRuntimeProviderContract} always
 * runs against the *fake* sandbox client (local temp dirs + real local
 * processes), so the baseline passes in CI with no provider access — this is the
 * green gate. The real (credentialed) client is exercised only when opted in via
 * `VERCEL_CONTRACT_LIVE=1` plus the `VERCEL_*` credentials, keeping live-API
 * calls off the default CI path. Both paths run the identical contract; only the
 * backing client differs.
 *
 * @module vercelSandbox/VercelSandboxRuntimeAdapter.contract.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionInstanceId, RuntimePlan, type RuntimeRole } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

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
import { VERCEL_SANDBOX_DESCRIPTOR } from "./descriptor.ts";
import { hasVercelSandboxCredentials } from "./Layers/VercelSandboxClientLive.ts";
import { makeVercelSandboxRuntimeAdapterLayer } from "./runtimeLayer.ts";
import { VercelSandboxAdapter } from "./Services/VercelSandboxAdapter.ts";

const decodePlan = Schema.decodeUnknownSync(RuntimePlan);

const registryLayer = makeRuntimeProviderRegistryLive({
  descriptors: [VERCEL_SANDBOX_DESCRIPTOR],
});

type ProviderServices = VercelSandboxAdapter | ExecutionRuntimePlanner;

interface ProviderMode {
  /** When set, resolve credentials from this env; `{}` forces the fake client. */
  readonly env: Record<string, string | undefined>;
}

const makeVercelProvider = (mode: ProviderMode): RuntimeProviderUnderTest<ProviderServices> => {
  const layer = Layer.mergeAll(
    makeVercelSandboxRuntimeAdapterLayer({ env: mode.env }),
    ExecutionRuntimePlannerLive.pipe(Layer.provide(registryLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const runtime = ManagedRuntime.make(layer);

  const provision = (
    threadId: string,
  ): Effect.Effect<ContractInstance, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* VercelSandboxAdapter;
      const context = yield* adapter.provision({
        threadId,
        plan: decodePlan({ targetKind: "remote-runtime", provider: "vercel-sandbox" }),
      });
      return { instanceId: context.instance.id, rootPath: context.rootPath };
    });

  const exec = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractExecResult, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* VercelSandboxAdapter;
      return yield* adapter.execCollect(instanceId, { command, args });
    });

  const createTransport = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractTransport, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* VercelSandboxAdapter;
      // The agent runs with the (fake) sandbox's environment; pass the host env so
      // the interpreter resolves on PATH, mirroring how a real sandbox carries its
      // own PATH for the agent process.
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
      const adapter = yield* VercelSandboxAdapter;
      return yield* adapter.isAlive(instanceId);
    });

  const destroy = (
    instanceId: ExecutionInstanceId,
  ): Effect.Effect<void, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* VercelSandboxAdapter;
      yield* adapter.destroy(instanceId);
    });

  const validatePlanForRole = (
    role: RuntimeRole,
  ): Effect.Effect<unknown, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      return yield* planner.validate(
        decodePlan({ targetKind: "remote-runtime", provider: "vercel-sandbox" }),
        role,
      );
    });

  return {
    descriptor: VERCEL_SANDBOX_DESCRIPTOR,
    runtime,
    provision,
    exec,
    createTransport,
    isAlive,
    destroy,
    validatePlanForRole,
  };
};

// Baseline: always fake-backed. An empty env forces the fake client regardless
// of any `VERCEL_*` credentials in the ambient shell — this is the green CI gate.
describeRuntimeProviderContract("vercel-sandbox (fake)", () => makeVercelProvider({ env: {} }));

// Live: opt-in only. Requires both the explicit flag and real credentials so a
// stray token in a dev shell never triggers live-API calls in a normal test run.
const liveEnabled =
  process.env.VERCEL_CONTRACT_LIVE === "1" && hasVercelSandboxCredentials(process.env);
if (liveEnabled) {
  describeRuntimeProviderContract("vercel-sandbox (live)", () =>
    makeVercelProvider({ env: process.env }),
  );
}
