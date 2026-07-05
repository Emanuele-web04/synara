// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type {
  OrchestrationThread,
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
} from "~/lib/openUsageRateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
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

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  threads?: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  codexHomePath?: string | null;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  fetchProviderData?: boolean;
}) {
  const shouldFetchProviderData = input.fetchProviderData ?? true;
  const shouldFetchLiveProviderUsage =
    shouldFetchProviderData &&
    input.provider !== null &&
    input.provider !== undefined &&
    input.providerSnapshot === undefined;
  const shouldFetchLocalProviderUsage = shouldFetchLiveProviderUsage;
  const allProviderUsageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: shouldFetchLiveProviderUsage,
      provider: input.provider ?? null,
    }),
  );
  const localUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider: input.provider,
      homePath: input.provider === "codex" ? input.codexHomePath || null : null,
      enabled: shouldFetchLocalProviderUsage,
    }),
  );
  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(input.provider, { enabled: shouldFetchProviderData }),
  );
  const liveProviderSnapshot = useMemo(
    () =>
      (allProviderUsageQuery.data ?? []).find((snapshot) => snapshot.provider === input.provider),
    [allProviderUsageQuery.data, input.provider],
  );
  const authoritativeLiveSnapshot = useMemo(
    () => liveProviderSnapshot ?? input.providerSnapshot ?? null,
    [input.providerSnapshot, liveProviderSnapshot],
  );
  // Explicit live failures are authoritative; only fall back when no live snapshot exists.
  const blocksProviderUsageFallback = isProviderUsageSnapshotNonOk(authoritativeLiveSnapshot);
  const accountRateLimits = useMemo(
    () => input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []),
    [input.threadRateLimits, input.threads],
  );

  const rateLimits = useMemo<ReadonlyArray<ProviderRateLimit>>(() => {
    if (blocksProviderUsageFallback) {
      return [];
    }

    const localSnapshot = localUsageSnapshotQuery.data ?? null;
    const derivedRateLimits = accountRateLimits.filter((rateLimit) =>
      input.provider ? rateLimit.provider === input.provider : true,
    );
    const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(authoritativeLiveSnapshot);
    const localUsageRateLimit = normalizeServerProviderUsageRateLimit(localSnapshot);
    const openUsageSnapshot = normalizeOpenUsageSnapshot(
      openUsageSnapshotQuery.data,
      input.provider,
    );
    return mergeProviderRateLimits(
      derivedRateLimits,
      mergeProviderRateLimits(
        liveUsageRateLimit ? [liveUsageRateLimit] : [],
        mergeProviderRateLimits(
          localUsageRateLimit ? [localUsageRateLimit] : [],
          openUsageSnapshot ? [openUsageSnapshot] : [],
        ),
      ),
    );
  }, [
    accountRateLimits,
    authoritativeLiveSnapshot,
    blocksProviderUsageFallback,
    input.provider,
    localUsageSnapshotQuery.data,
    openUsageSnapshotQuery.data,
  ]);

  const usageLines = useMemo(() => {
    if (blocksProviderUsageFallback) {
      return [];
    }

    const liveUsageLines = normalizeServerProviderUsageLines(authoritativeLiveSnapshot);
    if (liveUsageLines.length > 0) {
      return liveUsageLines;
    }
    const localUsageLines = normalizeServerProviderUsageLines(localUsageSnapshotQuery.data);
    if (localUsageLines.length > 0) {
      return localUsageLines;
    }
    return normalizeOpenUsageUsageLines(openUsageSnapshotQuery.data);
  }, [
    authoritativeLiveSnapshot,
    blocksProviderUsageFallback,
    localUsageSnapshotQuery.data,
    openUsageSnapshotQuery.data,
  ]);

  // A throttle/staleness note the server rides on an otherwise-ok snapshot (e.g. Claude serving the
  // last values while Anthropic rate-limits). Only surfaced when the snapshot is actually shown —
  // non-ok snapshots hide the section entirely, so their `detail` would never be seen anyway.
  const usageNotice = useMemo(() => {
    if (blocksProviderUsageFallback) {
      return undefined;
    }
    const detail = authoritativeLiveSnapshot?.detail?.trim();
    return detail ? detail : undefined;
  }, [authoritativeLiveSnapshot, blocksProviderUsageFallback]);

  const learnMoreHref = useMemo(
    () =>
      deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(input.provider),
    [input.provider, rateLimits],
  );

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
