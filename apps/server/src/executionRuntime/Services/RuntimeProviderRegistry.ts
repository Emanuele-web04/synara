/**
 * RuntimeProviderRegistry - Lookup boundary mapping an execution-runtime
 * provider to its descriptor and its lifecycle adapter.
 *
 * The planner uses descriptor lookup to resolve what a `RuntimePlan` is
 * validated against. `ExecutionRuntimeService` uses adapter lookup to route
 * provisioning, exec, and teardown by provider, so it never names a concrete
 * provider. The registry owns no lifecycle of its own and makes no provider
 * calls; it only resolves the registered descriptor/adapter.
 *
 * @module RuntimeProviderRegistry
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ExecutionRuntimeProvider } from "@t3tools/contracts";

import type { RuntimeProviderUnsupportedError } from "../Errors.ts";
import type { ExecutionRuntimeProviderAdapterShape } from "./ExecutionRuntimeProviderAdapter.ts";
import type { FakeRuntimeFlavor } from "./FakeRuntimeFlavor.ts";
import type { RuntimeProviderDescriptor } from "./RuntimeProviderDescriptor.ts";

export interface RuntimeProviderRegistryShape {
  /** Resolve the descriptor for a provider, or fail if none is registered. */
  readonly getDescriptor: (
    provider: ExecutionRuntimeProvider,
  ) => Effect.Effect<RuntimeProviderDescriptor, RuntimeProviderUnsupportedError>;
  /**
   * Resolve the lifecycle adapter for a provider, or fail if none is registered.
   * A provider with a descriptor but no adapter (validation-only wiring, or a
   * real provider not yet registered) fails here, which is the correct
   * pre-provision rejection until that provider's adapter lands.
   */
  readonly getAdapter: (
    provider: ExecutionRuntimeProvider,
  ) => Effect.Effect<ExecutionRuntimeProviderAdapterShape, RuntimeProviderUnsupportedError>;
  /**
   * Resolve a descriptor for a `fake`-family flavor. The `fake` provider has
   * several flavors with distinct capabilities, so flavor-keyed lookup is the
   * precise resolution the service uses before provisioning.
   */
  readonly getDescriptorByFlavor: (
    flavor: FakeRuntimeFlavor,
  ) => Effect.Effect<RuntimeProviderDescriptor, RuntimeProviderUnsupportedError>;
  /** List providers with a registered descriptor. */
  readonly listProviders: () => Effect.Effect<ReadonlyArray<ExecutionRuntimeProvider>>;
}

export class RuntimeProviderRegistry extends ServiceMap.Service<
  RuntimeProviderRegistry,
  RuntimeProviderRegistryShape
>()("t3/executionRuntime/Services/RuntimeProviderRegistry") {}
