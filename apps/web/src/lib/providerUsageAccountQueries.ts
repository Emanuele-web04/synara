// FILE: providerUsageAccountQueries.ts
// Purpose: Account-safe snapshot matching and recovery after a shared usage batch settles.

import type {
  ProviderInstanceId,
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { serverAllProviderUsageQueryOptions } from "./serverReactQuery";

export function findProviderUsageAccountSnapshot(
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>,
  provider: ProviderKind | null,
  instanceId?: ProviderInstanceId,
): ServerProviderUsageSnapshot | undefined {
  return snapshots.find(
    (snapshot) =>
      snapshot.provider === provider &&
      (snapshot.instanceId ?? snapshot.provider) === (instanceId ?? provider),
  );
}

export function resolveProviderUsageLiveQueryPolicy(input: {
  readonly provider: ProviderKind | null;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly providerSnapshot: ServerGetProviderUsageSnapshotResult | undefined;
  readonly batchSnapshots: ReadonlyArray<ServerProviderUsageSnapshot>;
  readonly shouldFetchLiveProviderUsage: boolean;
  readonly batchPending: boolean;
  readonly fetchOpenUsageData: boolean | undefined;
}) {
  const authoritativeLiveSnapshot =
    findProviderUsageAccountSnapshot(
      input.providerSnapshot === undefined
        ? input.batchSnapshots
        : input.providerSnapshot
          ? [input.providerSnapshot]
          : [],
      input.provider,
      input.instanceId,
    ) ?? null;
  // Driver-wide telemetry cannot be assigned to an account, including a default
  // account once the live API identifies its route explicitly.
  const accountScoped =
    input.instanceId !== undefined || authoritativeLiveSnapshot?.instanceId !== undefined;
  return {
    authoritativeLiveSnapshot,
    accountScoped,
    shouldFetchLocalProviderUsage:
      input.shouldFetchLiveProviderUsage &&
      !accountScoped &&
      !input.batchPending &&
      authoritativeLiveSnapshot === null,
    shouldFetchOpenUsage:
      !accountScoped &&
      !(input.shouldFetchLiveProviderUsage && input.batchPending) &&
      (input.fetchOpenUsageData ?? true),
  };
}

/** The local-archive endpoint has no account route. Recover through the live batch
 * API instead, sharing one request per driver even when several accounts are missing. */
export function providerUsageAccountFallbackQueryOptions(input: {
  provider: ProviderKind;
  enabled: boolean;
}) {
  return serverAllProviderUsageQueryOptions(input);
}
