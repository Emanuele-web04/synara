/**
 * Daytona provider contract test.
 *
 * The shared Phase-17 baseline {@link describeRuntimeProviderContract} always
 * runs against the *fake* sandbox client (local temp dirs + real local
 * processes), so the baseline passes in CI with no provider access — this is the
 * green gate. The real Daytona REST client is exercised only when opted in via
 * `DAYTONA_CONTRACT_LIVE=1` (plus `DAYTONA_API_KEY`), keeping live-API calls off
 * the default CI path. Both paths run the identical contract; only the backing
 * client differs.
 *
 * @module daytona/DaytonaRuntimeAdapter.contract.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionInstanceId, RuntimePlan, type RuntimeRole } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

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
import { daytonaCredentialsConfigured } from "./DaytonaConfig.ts";
import { DAYTONA_RUNTIME_DESCRIPTOR } from "./descriptor.ts";
import { DaytonaRuntimeAdapter } from "./DaytonaRuntimeAdapter.ts";
import { makeDaytonaRuntimeAdapterLayer } from "./runtimeLayer.ts";

const decodePlan = Schema.decodeUnknownSync(RuntimePlan);

const registryLayer = makeRuntimeProviderRegistryLive({
  descriptors: [DAYTONA_RUNTIME_DESCRIPTOR],
});

type ProviderServices = DaytonaRuntimeAdapter | ExecutionRuntimePlanner;

interface ProviderMode {
  /** When set, resolve credentials from this env; `{}` forces the fake client. */
  readonly env: Record<string, string | undefined>;
}

const makeDaytonaProvider = (mode: ProviderMode): RuntimeProviderUnderTest<ProviderServices> => {
  const layer = Layer.mergeAll(
    makeDaytonaRuntimeAdapterLayer({ env: mode.env }),
    ExecutionRuntimePlannerLive.pipe(Layer.provide(registryLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));
  const runtime = ManagedRuntime.make(layer);

  const provision = (
    threadId: string,
  ): Effect.Effect<ContractInstance, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* DaytonaRuntimeAdapter;
      const context = yield* adapter.provision({ threadId, ports: [], snapshotId: null });
      return { instanceId: context.instance.id, rootPath: context.rootPath };
    });

  const exec = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractExecResult, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* DaytonaRuntimeAdapter;
      return yield* adapter.execCollect(instanceId, { command, args });
    });

  const createTransport = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractTransport, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* DaytonaRuntimeAdapter;
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
      const adapter = yield* DaytonaRuntimeAdapter;
      return yield* adapter.isAlive(instanceId);
    });

  const destroy = (
    instanceId: ExecutionInstanceId,
  ): Effect.Effect<void, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* DaytonaRuntimeAdapter;
      yield* adapter.destroy(instanceId);
    });

  const validatePlanForRole = (
    role: RuntimeRole,
  ): Effect.Effect<unknown, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      return yield* planner.validate(
        decodePlan({ targetKind: "remote-runtime", provider: "daytona" }),
        role,
      );
    });

  return {
    descriptor: DAYTONA_RUNTIME_DESCRIPTOR,
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
// of any `DAYTONA_API_KEY` in the ambient shell — this is the green CI gate.
describeRuntimeProviderContract("daytona (fake)", () => makeDaytonaProvider({ env: {} }));

// Live: opt-in only. Requires both the explicit flag and real credentials so a
// stray key in a dev shell never triggers live-API calls in a normal test run.
const liveEnabled =
  process.env.DAYTONA_CONTRACT_LIVE === "1" && daytonaCredentialsConfigured(process.env);
if (liveEnabled) {
  describeRuntimeProviderContract("daytona (live)", () =>
    makeDaytonaProvider({ env: process.env }),
  );
}
