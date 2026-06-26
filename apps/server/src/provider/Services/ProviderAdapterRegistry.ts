/**
 * ProviderAdapterRegistry - Lookup boundary for provider adapter implementations.
 *
 * Maps a provider kind to the concrete adapter service (Codex, Claude, etc).
 * It does not own session lifecycle or routing rules; `ProviderService` uses
 * this registry together with `ProviderSessionDirectory`.
 *
 * @module ProviderAdapterRegistry
 */
import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderAdapterError, ProviderUnsupportedError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ProviderAdapterRegistryShape - Service API for adapter lookup by provider kind.
 */
export interface ProviderAdapterRegistryShape {
  /** Resolve an adapter facade scoped to one configured provider instance. */
  readonly getByInstance?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderUnsupportedError>;

  /**
   * Resolve the adapter for a provider kind.
   */
  readonly getByProvider: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, ProviderUnsupportedError>;

  /**
   * List provider kinds currently registered.
   */
  readonly listProviders: () => Effect.Effect<ReadonlyArray<ProviderKind>>;

  /** List enabled configured instances backed by registered adapters. */
  readonly listInstances?: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
}

/**
 * ProviderAdapterRegistry - Service tag for provider adapter lookup.
 */
export class ProviderAdapterRegistry extends ServiceMap.Service<
  ProviderAdapterRegistry,
  ProviderAdapterRegistryShape
>()("synara/provider/Services/ProviderAdapterRegistry") {}

// Dummy comment for workflow testing.
