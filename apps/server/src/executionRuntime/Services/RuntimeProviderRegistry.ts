/**
 * RuntimeProviderRegistry - Lookup boundary mapping an execution-runtime
 * provider to its descriptor (and, in later slices, its adapter).
 *
 * The planner uses this to resolve the descriptor a `RuntimePlan` is validated
 * against. It owns no lifecycle and makes no provider calls.
 *
 * @module RuntimeProviderRegistry
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ExecutionRuntimeProvider } from "@t3tools/contracts";

import type { RuntimeProviderUnsupportedError } from "../Errors.ts";
import type { FakeRuntimeFlavor } from "./FakeRuntimeFlavor.ts";
import type { RuntimeProviderDescriptor } from "./RuntimeProviderDescriptor.ts";

export interface RuntimeProviderRegistryShape {
  /** Resolve the descriptor for a provider, or fail if none is registered. */
  readonly getDescriptor: (
    provider: ExecutionRuntimeProvider,
  ) => Effect.Effect<RuntimeProviderDescriptor, RuntimeProviderUnsupportedError>;
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
