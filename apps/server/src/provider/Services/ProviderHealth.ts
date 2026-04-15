/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns provider health checks, cache-backed snapshots, and change streaming
 * for transport layers that need provider install/auth status.
 *
 * @module ProviderHealth
 */
import type { ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderHealthShape {
  /**
   * Read the latest provider health statuses.
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Force a foreground refresh of provider health snapshots.
   */
  readonly refresh: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Stream of provider snapshot changes for config consumers.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderStatus>>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "t3/provider/Services/ProviderHealth",
) {}
