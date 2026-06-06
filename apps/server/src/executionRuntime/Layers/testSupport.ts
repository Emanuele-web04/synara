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
import { Effect, Layer } from "effect";

import { BUILT_IN_RUNTIME_DESCRIPTORS } from "./descriptors.ts";
import { ExecutionRuntimePlannerLive } from "./ExecutionRuntimePlanner.ts";
import { FAKE_RUNTIME_DESCRIPTORS } from "./fakeDescriptors.ts";
import { FakeRuntimeProviderAdapterLive } from "./FakeRuntimeProviderAdapter.ts";
import { makeRuntimeProviderRegistryWithFakeLive } from "./RuntimeProviderRegistry.ts";
import { RuntimeActivityLeaseManagerLive } from "./RuntimeActivityLeaseManager.ts";
import { RuntimeWorkspaceDiffLive } from "./RuntimeWorkspaceDiff.ts";
import { DAYTONA_RUNTIME_DESCRIPTOR } from "../providers/daytona/descriptor.ts";
import { VERCEL_SANDBOX_DESCRIPTOR } from "../providers/vercelSandbox/descriptor.ts";
import { MODAL_PROVIDER_DESCRIPTOR } from "../providers/modal/modalDescriptors.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./cloudflareDescriptor.ts";
import { RuntimeProviderCredentials } from "../Services/RuntimeProviderCredentials.ts";

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

/**
 * A stub credential service that reports nothing configured. Harnesses that drive
 * the `fake` provider (which needs no credentials) use it to satisfy the service's
 * missing-creds preflight without touching Settings or the secret store. Adapter
 * layers in those harnesses pin their own `env` override, so this stub's
 * `envFor`/`credentialsConfigured` are never consulted for real selection.
 */
export const RuntimeProviderCredentialsTestLive = Layer.succeed(RuntimeProviderCredentials, {
  envFor: () => Effect.succeed({ ...process.env }),
  credentialsConfigured: () => Effect.succeed(false),
});

/**
 * Planner + registry (with fake descriptors + adapter), the activity-lease
 * manager the service injects for the keepalive, and the remote workspace-diff
 * seam — for the execution-runtime service, without a credential service so a
 * caller can pin its own.
 */
export const ExecutionRuntimePlanningOnlyTestLive = Layer.mergeAll(
  ExecutionRuntimePlannerLive.pipe(Layer.provide(runtimeProviderRegistryLayer)),
  runtimeProviderRegistryLayer,
  RuntimeActivityLeaseManagerLive,
  RuntimeWorkspaceDiffLive.pipe(Layer.provide(runtimeProviderRegistryLayer)),
);

/**
 * Planner + registry (with fake descriptors + adapter) and a stub credential
 * service for the execution-runtime service.
 */
export const ExecutionRuntimePlanningTestLive = Layer.mergeAll(
  ExecutionRuntimePlanningOnlyTestLive,
  RuntimeProviderCredentialsTestLive,
);
