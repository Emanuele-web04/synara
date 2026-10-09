// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type {
  OrchestrationThread,
  ProviderInstanceId,
  ProviderKind,
  ServerCodexResetCredits,
  ServerGetProviderUsageSnapshotResult,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
  type OpenUsageUsageLine,
} from "~/lib/openUsageRateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
import { resolveProviderUsageLiveQueryPolicy } from "~/lib/providerUsageAccountQueries";
import {
  isProviderUsageSnapshotNonOk,
  normalizeServerProviderUsageLines,
  normalizeServerProviderUsageRateLimit,
} from "~/lib/providerUsageSnapshot";
import {
  deriveProviderUsageLearnMoreHref,
  deriveRateLimitLearnMoreHref,
  deriveAccountRateLimits,
  mergeProviderRateLimits,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import {
  serverAllProviderUsageQueryOptions,
  serverProviderUsageSnapshotQueryOptions,
} from "~/lib/serverReactQuery";

export interface ProviderUsageSummaryData {
  readonly learnMoreHref: string | null;
  readonly rateLimits: ReadonlyArray<ProviderRateLimit>;
  readonly usageLines: ReadonlyArray<OpenUsageUsageLine>;
  readonly usageNotice: string | undefined;
  readonly resetCredits?: ServerCodexResetCredits | undefined;
}

export function resolveProviderUsageSummary(input: {
  provider: ProviderKind | null;
  accountRateLimits: ReadonlyArray<ProviderRateLimit>;
  authoritativeLiveSnapshot: ServerGetProviderUsageSnapshotResult;
  localUsageSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  openUsageSnapshot?: unknown;
}): ProviderUsageSummaryData {
  const blocksFallback = isProviderUsageSnapshotNonOk(input.authoritativeLiveSnapshot);
  if (blocksFallback) {
    return {
      learnMoreHref: deriveProviderUsageLearnMoreHref(input.provider),
      rateLimits: [],
      usageLines: [],
      usageNotice: undefined,
      resetCredits: undefined,
    };
  }

  const derivedRateLimits = input.accountRateLimits.filter((rateLimit) =>
    input.provider ? rateLimit.provider === input.provider : true,
  );
  const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(input.authoritativeLiveSnapshot);
  const localUsageRateLimit = normalizeServerProviderUsageRateLimit(input.localUsageSnapshot);
  const openUsageRateLimit = normalizeOpenUsageSnapshot(input.openUsageSnapshot, input.provider);
  const rateLimits = mergeProviderRateLimits(
    derivedRateLimits,
    mergeProviderRateLimits(
      liveUsageRateLimit ? [liveUsageRateLimit] : [],
      mergeProviderRateLimits(
        localUsageRateLimit ? [localUsageRateLimit] : [],
        openUsageRateLimit ? [openUsageRateLimit] : [],
      ),
    ),
  );

  const liveUsageLines = normalizeServerProviderUsageLines(input.authoritativeLiveSnapshot);
  const localUsageLines = normalizeServerProviderUsageLines(input.localUsageSnapshot);
  const usageLines =
    liveUsageLines.length > 0
      ? liveUsageLines
      : localUsageLines.length > 0
        ? localUsageLines
        : normalizeOpenUsageUsageLines(input.openUsageSnapshot);
  const detail = input.authoritativeLiveSnapshot?.detail?.trim();

  return {
    learnMoreHref:
      deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(input.provider),
    rateLimits,
    usageLines,
    usageNotice: detail ? detail : undefined,
    resetCredits:
      input.authoritativeLiveSnapshot?.provider === "codex"
        ? input.authoritativeLiveSnapshot.resetCredits
        : undefined,
  };
}

function providerUsageSummaryIsLoading(
  snapshot: ServerGetProviderUsageSnapshotResult,
  summary: ProviderUsageSummaryData,
  queryPending: boolean,
): boolean {
  return (
    queryPending &&
    !isProviderUsageSnapshotNonOk(snapshot) &&
    summary.rateLimits.length === 0 &&
    summary.usageLines.length === 0
  );
}

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  instanceId?: ProviderInstanceId | undefined;
  threads?: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  codexHomePath?: string | null;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  /** Defer provider-wide fallback reads while the caller's shared batch is in flight. */
  providerSnapshotPending?: boolean | undefined;
  fetchOpenUsageData?: boolean | undefined;
}) {
  const provider = input.provider ?? null;
  const instanceId = input.instanceId ?? input.providerSnapshot?.instanceId;
  const shouldFetchLiveProviderUsage = provider !== null && input.providerSnapshot === undefined;
  const allProviderUsageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: shouldFetchLiveProviderUsage,
    }),
  );
  const batchPending =
    input.providerSnapshotPending === true ||
    allProviderUsageQuery.isPending ||
    allProviderUsageQuery.isFetching;
  const {
    authoritativeLiveSnapshot,
    accountScoped,
    shouldFetchLocalProviderUsage,
    shouldFetchOpenUsage,
  } = resolveProviderUsageLiveQueryPolicy({
    provider,
    instanceId,
    providerSnapshot: input.providerSnapshot,
    batchSnapshots: allProviderUsageQuery.data ?? [],
    shouldFetchLiveProviderUsage,
    batchPending,
    fetchOpenUsageData: input.fetchOpenUsageData,
  });
  const localUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider,
      homePath: provider === "codex" ? input.codexHomePath || null : null,
      enabled: shouldFetchLocalProviderUsage,
    }),
  );
  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(provider, {
      enabled: shouldFetchOpenUsage,
    }),
  );
  const accountRateLimits = accountScoped
    ? []
    : (input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []));
  const localUsageSnapshot = accountScoped ? null : (localUsageSnapshotQuery.data ?? null);
  const providerSnapshot = authoritativeLiveSnapshot ?? localUsageSnapshot;
  const summary = resolveProviderUsageSummary({
    provider,
    accountRateLimits,
    authoritativeLiveSnapshot: providerSnapshot,
    localUsageSnapshot,
    openUsageSnapshot: accountScoped ? undefined : openUsageSnapshotQuery.data,
  });

  const isLoading = providerUsageSummaryIsLoading(
    providerSnapshot,
    summary,
    (shouldFetchLiveProviderUsage && batchPending) ||
      (shouldFetchLocalProviderUsage && localUsageSnapshotQuery.isPending),
  );

  return {
    isLoading,
    providerSnapshot,
    ...summary,
  } as const;
}
