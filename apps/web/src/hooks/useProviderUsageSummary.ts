// FILE: useProviderUsageSummary.ts
// Purpose: Merge account usage signals from provider snapshots, runtime thread
// limits, and optional OpenUsage data into one UI-friendly summary.

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
import {
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
  // Explicit live failures are authoritative; only fall back when no live snapshot exists.
  // "Unsupported" is an honest capability result, not a failed fetch. Keep
  // runtime/local activity and thread-reported limits visible for providers
  // that do not expose a safe account endpoint yet.
  const blocksFallback =
    input.authoritativeLiveSnapshot?.status === "needs-auth" ||
    input.authoritativeLiveSnapshot?.status === "error";
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

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  instanceId?: ProviderInstanceId | undefined;
  threads?: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
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
  const liveProviderSnapshot = (allProviderUsageQuery.data ?? []).find(
    (snapshot) =>
      snapshot.provider === provider &&
      (snapshot.instanceId ?? snapshot.provider) === (instanceId ?? provider),
  );
  const authoritativeLiveSnapshot =
    input.providerSnapshot !== undefined ? input.providerSnapshot : (liveProviderSnapshot ?? null);
  // Thread, local and OpenUsage fallbacks identify only the driver. They cannot be
  // attributed to a selected account, even when that account is the default one.
  const accountScoped =
    instanceId !== undefined || authoritativeLiveSnapshot?.instanceId !== undefined;
  const shouldFetchLocalProviderUsage = shouldFetchLiveProviderUsage && !accountScoped;
  const localUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider,
      enabled: shouldFetchLocalProviderUsage,
    }),
  );
  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(provider, {
      enabled: !accountScoped && (input.fetchOpenUsageData ?? true),
    }),
  );
  const accountRateLimits = accountScoped
    ? []
    : (input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []));
  const summary = resolveProviderUsageSummary({
    provider,
    accountRateLimits,
    authoritativeLiveSnapshot,
    localUsageSnapshot: accountScoped ? null : (localUsageSnapshotQuery.data ?? null),
    openUsageSnapshot: accountScoped ? undefined : openUsageSnapshotQuery.data,
  });

  const isLoading =
    shouldFetchLiveProviderUsage &&
    allProviderUsageQuery.isPending &&
    (!shouldFetchLocalProviderUsage || localUsageSnapshotQuery.isPending) &&
    summary.rateLimits.length === 0 &&
    summary.usageLines.length === 0;

  return {
    isLoading,
    ...summary,
  } as const;
}
