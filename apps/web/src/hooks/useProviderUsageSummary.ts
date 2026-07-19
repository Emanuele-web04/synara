// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type {
  OrchestrationThread,
  ProviderKind,
  ServerGetProviderUsageSnapshotResult,
} from "@synara/contracts";
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
  includeSupplementalData?: boolean | undefined;
}) {
  const provider = input.provider ?? null;
  const shouldFetchProviderData = input.fetchProviderData ?? true;
  const includeSupplementalData = input.includeSupplementalData ?? true;
  const shouldFetchLiveProviderUsage =
    shouldFetchProviderData && provider !== null && input.providerSnapshot === undefined;
  const shouldFetchLocalProviderUsage = shouldFetchLiveProviderUsage && includeSupplementalData;
  const allProviderUsageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: shouldFetchLiveProviderUsage,
      provider,
    }),
  );
  const localUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider,
      homePath: provider === "codex" ? input.codexHomePath || null : null,
      enabled: shouldFetchLocalProviderUsage,
    }),
  );
  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(provider, {
      enabled: shouldFetchProviderData && includeSupplementalData,
    }),
  );
  const liveProviderSnapshot = useMemo(
    () =>
      shouldFetchLiveProviderUsage
        ? (allProviderUsageQuery.data ?? []).find((snapshot) => snapshot.provider === provider)
        : undefined,
    [allProviderUsageQuery.data, provider, shouldFetchLiveProviderUsage],
  );
  const authoritativeLiveSnapshot = useMemo(
    () => input.providerSnapshot ?? liveProviderSnapshot ?? null,
    [input.providerSnapshot, liveProviderSnapshot],
  );
  // Explicit live failures are authoritative; only fall back when no live snapshot exists.
  const blocksProviderUsageFallback = isProviderUsageSnapshotNonOk(authoritativeLiveSnapshot);
  const accountRateLimits = useMemo(
    () =>
      includeSupplementalData
        ? (input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []))
        : [],
    [includeSupplementalData, input.threadRateLimits, input.threads],
  );

  const rateLimits = useMemo<ReadonlyArray<ProviderRateLimit>>(() => {
    if (blocksProviderUsageFallback) {
      return [];
    }

    const localSnapshot = includeSupplementalData ? (localUsageSnapshotQuery.data ?? null) : null;
    const derivedRateLimits = accountRateLimits.filter((rateLimit) =>
      provider ? rateLimit.provider === provider : true,
    );
    const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(authoritativeLiveSnapshot);
    const localUsageRateLimit = normalizeServerProviderUsageRateLimit(localSnapshot);
    const openUsageSnapshot = includeSupplementalData
      ? normalizeOpenUsageSnapshot(openUsageSnapshotQuery.data, provider)
      : null;
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
    includeSupplementalData,
    localUsageSnapshotQuery.data,
    openUsageSnapshotQuery.data,
    provider,
  ]);

  const usageLines = useMemo(() => {
    if (blocksProviderUsageFallback) {
      return [];
    }

    const liveUsageLines = normalizeServerProviderUsageLines(authoritativeLiveSnapshot);
    if (liveUsageLines.length > 0) {
      return liveUsageLines;
    }
    const localUsageLines = includeSupplementalData
      ? normalizeServerProviderUsageLines(localUsageSnapshotQuery.data)
      : [];
    if (localUsageLines.length > 0) {
      return localUsageLines;
    }
    return includeSupplementalData ? normalizeOpenUsageUsageLines(openUsageSnapshotQuery.data) : [];
  }, [
    authoritativeLiveSnapshot,
    blocksProviderUsageFallback,
    includeSupplementalData,
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
    () => deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(provider),
    [provider, rateLimits],
  );

  const isLoading =
    shouldFetchLiveProviderUsage &&
    allProviderUsageQuery.isPending &&
    localUsageSnapshotQuery.isPending &&
    rateLimits.length === 0 &&
    usageLines.length === 0;

  const snapshotStatus = authoritativeLiveSnapshot?.status ?? null;
  const snapshotDetail = authoritativeLiveSnapshot?.detail?.trim() || null;
  const planName = authoritativeLiveSnapshot?.planName?.trim() || null;

  return {
    isLoading,
    learnMoreHref,
    planName,
    rateLimits,
    snapshotDetail,
    snapshotStatus,
    usageLines,
    usageNotice,
  } as const;
}
