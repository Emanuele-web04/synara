/**
 * Cloudflare provider contract test.
 *
 * The shared Phase-17 baseline {@link describeRuntimeProviderContract} always
 * runs against the *fake* bridge connection (real per-instance temp dirs + real
 * local processes), so the baseline passes in CI with no provider access — this
 * is the green gate. The real bridge HTTP/WS connection is exercised only when
 * opted in via `SYNARA_CLOUDFLARE_BRIDGE_URL` + `SYNARA_CLOUDFLARE_BRIDGE_TOKEN`,
 * keeping live calls off the default CI path. Both paths run the identical
 * contract; only the backing bridge connection differs.
 *
 * Cloudflare's terminal transport forwards a real channel (the bridge terminal
 * WebSocket) into the line transport, so `createTransport` returns a bare
 * transport with no in-memory controller — the one documented use of the shared
 * harness's optional `controller` field.
 *
 * @module CloudflareRuntimeProviderAdapter.contract.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionInstanceId, RuntimePlan, type RuntimeRole } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { FetchHttpClient } from "effect/unstable/http";

import { CloudflareBridgeClientLive } from "./CloudflareBridgeClient.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./cloudflareDescriptor.ts";
import { CloudflareRuntimeProviderAdapterLive } from "./CloudflareRuntimeProviderAdapter.ts";
import { makeCloudflareBridgeConnectionLayer } from "./CloudflareRuntimeProviderFacadeLayer.ts";
import { ExecutionRuntimePlannerLive } from "./ExecutionRuntimePlanner.ts";
import { makeRuntimeProviderRegistryLive } from "./RuntimeProviderRegistry.ts";
import { CloudflareRuntimeProviderAdapter } from "../Services/CloudflareRuntimeProviderAdapter.ts";
import { ExecutionRuntimePlanner } from "../Services/ExecutionRuntimePlanner.ts";
import {
  describeRuntimeProviderContract,
  type ContractExecResult,
  type ContractInstance,
  type ContractTransport,
  type RuntimeProviderUnderTest,
} from "../providers/contract/describeRuntimeProviderContract.ts";

const decodePlan = Schema.decodeUnknownSync(RuntimePlan);

const registryLayer = makeRuntimeProviderRegistryLive({
  descriptors: [CLOUDFLARE_RUNTIME_DESCRIPTOR],
});

// The Cloudflare exec/terminal ops run through the (fake or real) bridge
// connection. The fake connection spawns local processes, so `ChildProcessSpawner`
// (and `FileSystem`, both from `NodeServices.layer`) join the provider services;
// the real connection uses `HttpClient` (from `FetchHttpClient.layer`). The shared
// harness runs every op against one runtime, so all join the requirement channel.
type ProviderServices =
  | CloudflareRuntimeProviderAdapter
  | ExecutionRuntimePlanner
  | ChildProcessSpawner.ChildProcessSpawner;

interface ProviderMode {
  /** When set, resolve credentials from this env; `{}` forces the fake bridge. */
  readonly env: Record<string, string | undefined>;
}

const makeCloudflareProvider = (mode: ProviderMode): RuntimeProviderUnderTest<ProviderServices> => {
  const adapterLayer = CloudflareRuntimeProviderAdapterLive.pipe(
    Layer.provide(CloudflareBridgeClientLive),
    Layer.provide(makeCloudflareBridgeConnectionLayer({ env: mode.env })),
  );
  const layer = Layer.mergeAll(
    adapterLayer,
    ExecutionRuntimePlannerLive.pipe(Layer.provide(registryLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));
  const runtime = ManagedRuntime.make(layer);

  const provision = (
    threadId: string,
  ): Effect.Effect<ContractInstance, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* CloudflareRuntimeProviderAdapter;
      const context = yield* adapter.provision({ threadId });
      return { instanceId: context.instance.id, rootPath: context.rootPath };
    });

  const exec = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractExecResult, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* CloudflareRuntimeProviderAdapter;
      return yield* adapter.execCollect(instanceId, { command, args });
    });

  const createTransport = (
    instanceId: ExecutionInstanceId,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<ContractTransport, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* CloudflareRuntimeProviderAdapter;
      // The agent runs with the (fake) bridge's environment; pass the host env so
      // the interpreter resolves on PATH, mirroring how a real Cloudflare instance
      // carries its own PATH for the agent process. Cloudflare returns a bare
      // transport (no in-memory controller); the harness drives only the transport.
      const transport = yield* adapter.createTransport(instanceId, {
        command,
        args,
        cwd: ".",
        env: process.env,
      });
      return { transport };
    });

  const isAlive = (
    instanceId: ExecutionInstanceId,
  ): Effect.Effect<boolean, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* CloudflareRuntimeProviderAdapter;
      return yield* adapter.isAlive(instanceId);
    });

  const destroy = (
    instanceId: ExecutionInstanceId,
  ): Effect.Effect<void, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const adapter = yield* CloudflareRuntimeProviderAdapter;
      yield* adapter.destroy(instanceId);
    });

  const validatePlanForRole = (
    role: RuntimeRole,
  ): Effect.Effect<unknown, unknown, ProviderServices> =>
    Effect.gen(function* () {
      const planner = yield* ExecutionRuntimePlanner;
      return yield* planner.validate(
        decodePlan({ targetKind: "remote-runtime", provider: "cloudflare" }),
        role,
      );
    });

  return {
    descriptor: CLOUDFLARE_RUNTIME_DESCRIPTOR,
    runtime,
    provision,
    exec,
    createTransport,
    isAlive,
    destroy,
    validatePlanForRole,
  };
};

// Baseline: always fake-backed. An empty env forces the fake bridge regardless of
// any `SYNARA_CLOUDFLARE_BRIDGE_*` in the ambient shell — this is the green CI gate.
describeRuntimeProviderContract("cloudflare (fake)", () => makeCloudflareProvider({ env: {} }));

// Live: opt-in only. Requires the real bridge URL + token so a stray value in a
// dev shell never triggers live calls in a normal test run.
const liveEnabled =
  typeof process.env.SYNARA_CLOUDFLARE_BRIDGE_URL === "string" &&
  process.env.SYNARA_CLOUDFLARE_BRIDGE_URL.length > 0 &&
  typeof process.env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN === "string" &&
  process.env.SYNARA_CLOUDFLARE_BRIDGE_TOKEN.length > 0;
if (liveEnabled) {
  describeRuntimeProviderContract("cloudflare (live)", () =>
    makeCloudflareProvider({ env: process.env }),
  );
}
