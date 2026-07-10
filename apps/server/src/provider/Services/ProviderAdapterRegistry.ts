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
 * ProviderAdapterRegistryShape - Service API for adapter lookup.
 */
export interface ProviderAdapterRegistryShape {
  /**
   * Resolve an adapter facade for one configured provider instance.
   * Disabled instances fail by default; stop/cleanup paths may opt in via
   * `allowDisabled` to tear down sessions that outlived the instance toggle.
   */
  readonly getByInstance?: (
    instanceId: ProviderInstanceId,
    options?: { readonly allowDisabled?: boolean },
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

  /**
   * List configured provider instance ids when the registry is settings-aware.
   */
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
