// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type {
  OrchestrationThread,
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
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

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  threads?: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  fetchOpenUsageData?: boolean | undefined;
}) {
  const provider = input.provider ?? null;
  const shouldFetchLiveProviderUsage = provider !== null && input.providerSnapshot === undefined;
  const shouldFetchLocalProviderUsage = shouldFetchLiveProviderUsage;
  const allProviderUsageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: shouldFetchLiveProviderUsage,
    }),
  );
  const localUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider,
      enabled: shouldFetchLocalProviderUsage,
    }),
  );
  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(provider, {
      enabled: input.fetchOpenUsageData ?? true,
    }),
  );
  const liveProviderSnapshot = (allProviderUsageQuery.data ?? []).find(
    (snapshot) => snapshot.provider === provider,
  );
  const authoritativeLiveSnapshot = liveProviderSnapshot ?? input.providerSnapshot ?? null;
  // Explicit live failures are authoritative; only fall back when no live snapshot exists.
  // "Unsupported" is an honest capability result, not a failed fetch. Keep
  // runtime/local activity and thread-reported limits visible for providers
  // that do not expose a safe account endpoint yet.
  const blocksProviderUsageFallback =
    authoritativeLiveSnapshot?.status === "needs-auth" ||
    authoritativeLiveSnapshot?.status === "error";
  const accountRateLimits = input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []);

  let rateLimits: ReadonlyArray<ProviderRateLimit> = [];
  if (!blocksProviderUsageFallback) {
    const localSnapshot = localUsageSnapshotQuery.data ?? null;
    const derivedRateLimits = accountRateLimits.filter((rateLimit) =>
      provider ? rateLimit.provider === provider : true,
    );
    const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(authoritativeLiveSnapshot);
    const localUsageRateLimit = normalizeServerProviderUsageRateLimit(localSnapshot);
    const openUsageSnapshot = normalizeOpenUsageSnapshot(openUsageSnapshotQuery.data, provider);
    rateLimits = mergeProviderRateLimits(
      derivedRateLimits,
      mergeProviderRateLimits(
        liveUsageRateLimit ? [liveUsageRateLimit] : [],
        mergeProviderRateLimits(
          localUsageRateLimit ? [localUsageRateLimit] : [],
          openUsageSnapshot ? [openUsageSnapshot] : [],
        ),
      ),
    );
  }

  let usageLines: ReturnType<typeof normalizeServerProviderUsageLines> = [];
  if (!blocksProviderUsageFallback) {
    const liveUsageLines = normalizeServerProviderUsageLines(authoritativeLiveSnapshot);
    if (liveUsageLines.length > 0) {
      usageLines = liveUsageLines;
    } else {
      const localUsageLines = normalizeServerProviderUsageLines(localUsageSnapshotQuery.data);
      usageLines =
        localUsageLines.length > 0
          ? localUsageLines
          : normalizeOpenUsageUsageLines(openUsageSnapshotQuery.data);
    }
  }

  // A throttle/staleness note the server rides on an otherwise-ok snapshot (e.g. Claude serving the
  // last values while Anthropic rate-limits). Only surfaced when the snapshot is actually shown —
  // non-ok snapshots hide the section entirely, so their `detail` would never be seen anyway.
  const detail = blocksProviderUsageFallback
    ? undefined
    : authoritativeLiveSnapshot?.detail?.trim();
  const usageNotice = detail ? detail : undefined;

  const learnMoreHref =
    deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(provider);

  const isLoading =
    shouldFetchLiveProviderUsage &&
    allProviderUsageQuery.isPending &&
    localUsageSnapshotQuery.isPending &&
    rateLimits.length === 0 &&
    usageLines.length === 0;

  return {
    isLoading,
    learnMoreHref,
    rateLimits,
    usageLines,
    usageNotice,
  } as const;
}
