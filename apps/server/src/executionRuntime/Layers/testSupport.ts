/**
 * Test-support layers for the execution-runtime service.
 *
 * `ExecutionRuntimeServiceLive` validates a `runtimePlan` against the resolved
 * provider descriptor and routes provisioning through the registered adapter, so
 * it needs an `ExecutionRuntimePlanner` and a `RuntimeProviderRegistry` that
 * carries the `fake` adapter. Production wiring builds these in `serverLayers.ts`;
 * harnesses and tests use this layer so the service's dependencies match without
 * duplicating the descriptor set.
 *
 * @module executionRuntime/testSupport
 */
import { Layer } from "effect";

import { BUILT_IN_RUNTIME_DESCRIPTORS } from "./descriptors.ts";
import { ExecutionRuntimePlannerLive } from "./ExecutionRuntimePlanner.ts";
import { FAKE_RUNTIME_DESCRIPTORS } from "./fakeDescriptors.ts";
import { FakeRuntimeProviderAdapterLive } from "./FakeRuntimeProviderAdapter.ts";
import { makeRuntimeProviderRegistryWithFakeLive } from "./RuntimeProviderRegistry.ts";
import { DAYTONA_RUNTIME_DESCRIPTOR } from "../providers/daytona/descriptor.ts";
import { VERCEL_SANDBOX_DESCRIPTOR } from "../providers/vercelSandbox/descriptor.ts";
import { MODAL_PROVIDER_DESCRIPTOR } from "../providers/modal/modalDescriptors.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./cloudflareDescriptor.ts";

// Real provider descriptors register here so the planner validates their plans
// pre-provision; their lifecycle adapters do not (these tests drive the fake
// provider only), so the fake-only registry layer is enough.
const runtimeProviderRegistryLayer = makeRuntimeProviderRegistryWithFakeLive({
  descriptors: [
    ...BUILT_IN_RUNTIME_DESCRIPTORS,
    ...FAKE_RUNTIME_DESCRIPTORS,
    DAYTONA_RUNTIME_DESCRIPTOR,
    VERCEL_SANDBOX_DESCRIPTOR,
    MODAL_PROVIDER_DESCRIPTOR,
    CLOUDFLARE_RUNTIME_DESCRIPTOR,
  ],
}).pipe(Layer.provide(FakeRuntimeProviderAdapterLive));

/** Planner + registry (with fake descriptors + adapter) for the execution-runtime service. */
export const ExecutionRuntimePlanningTestLive = Layer.mergeAll(
  ExecutionRuntimePlannerLive.pipe(Layer.provide(runtimeProviderRegistryLayer)),
  runtimeProviderRegistryLayer,
);
