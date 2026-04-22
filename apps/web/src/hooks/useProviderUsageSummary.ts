// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type { OrchestrationThread, ProviderKind } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

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
import { serverProviderUsageSnapshotQueryOptions } from "~/lib/serverReactQuery";

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  threads: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  codexHomePath?: string | null;
}) {
  const providerUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider: input.provider,
      homePath: input.provider === "codex" ? input.codexHomePath || null : null,
    }),
  );
  const openUsageSnapshotQuery = useQuery(openUsageProviderSnapshotQueryOptions(input.provider));

  const rateLimits = useMemo<ReadonlyArray<ProviderRateLimit>>(() => {
    const derivedRateLimits = deriveAccountRateLimits(input.threads).filter((rateLimit) =>
      input.provider ? rateLimit.provider === input.provider : true,
    );
    const serverUsageRateLimit = normalizeServerProviderUsageRateLimit(
      providerUsageSnapshotQuery.data,
    );
    const openUsageSnapshot = normalizeOpenUsageSnapshot(
      openUsageSnapshotQuery.data,
      input.provider,
    );
    return mergeProviderRateLimits(
      derivedRateLimits,
      mergeProviderRateLimits(
        serverUsageRateLimit ? [serverUsageRateLimit] : [],
        openUsageSnapshot ? [openUsageSnapshot] : [],
      ),
    );
  }, [input.provider, input.threads, openUsageSnapshotQuery.data, providerUsageSnapshotQuery.data]);

  const usageLines = useMemo(() => {
    const serverUsageLines = normalizeServerProviderUsageLines(providerUsageSnapshotQuery.data);
    if (serverUsageLines.length > 0) {
      return serverUsageLines;
    }
    return normalizeOpenUsageUsageLines(openUsageSnapshotQuery.data);
  }, [openUsageSnapshotQuery.data, providerUsageSnapshotQuery.data]);

  const learnMoreHref = useMemo(
    () =>
      deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(input.provider),
    [input.provider, rateLimits],
  );

  const isLoading =
    input.provider !== null &&
    input.provider !== undefined &&
    providerUsageSnapshotQuery.isPending &&
    rateLimits.length === 0 &&
    usageLines.length === 0;

  return {
    isLoading,
    learnMoreHref,
    rateLimits,
    usageLines,
  } as const;
}
