// FILE: EnvironmentUsageSection.logic.ts
// Purpose: Pure compact-summary decisions for provider rows in the Environment panel.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import type { ResolvedProviderInstance } from "@synara/shared/providerInstances";

import { getRailUsageAccounts } from "~/components/AppRailUsage.logic";
import { findProviderUsageAccountSnapshot } from "~/lib/providerUsageAccountQueries";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";
import { normalizeServerProviderUsageRateLimit } from "~/lib/providerUsageSnapshot";

export function selectEnvironmentUsageAccounts(input: {
  readonly instances: ReadonlyArray<ResolvedProviderInstance>;
  readonly snapshots: ReadonlyArray<ServerProviderUsageSnapshot>;
}) {
  const accounts = getRailUsageAccounts(input.instances);
  return accounts.flatMap(({ instance, label }) => {
    const snapshot = findProviderUsageAccountSnapshot(
      input.snapshots,
      instance.driver,
      instance.instanceId,
    );
    if (!snapshot) return [];
    const status = snapshot.status ?? "ok";
    const rateLimit = normalizeServerProviderUsageRateLimit(snapshot);
    const hasUsage =
      status === "ok" &&
      (deriveProviderUsageDisplayRows(rateLimit ? [rateLimit] : []).length > 0 ||
        snapshot.usageLines.length > 0 ||
        (snapshot.resetCredits?.availableCount ?? 0) > 0);
    // Unused defaults should not crowd the panel just because other drivers are
    // enabled. Configured accounts still explain expired credentials and failures.
    const showAuth =
      status === "needs-auth" &&
      (!instance.isDefault ||
        Boolean(instance.raw.displayName?.trim()) ||
        accounts.filter((account) => account.instance.driver === instance.driver).length > 1);
    if (!hasUsage && !showAuth && status !== "error" && status !== "unsupported") return [];
    return [{ instance, snapshot, label }];
  });
}

export interface EnvironmentProviderUsageSummary {
  readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
  readonly statusLabel: string;
  readonly ariaLabel: string;
}

function providerUsageStatusLabel(
  snapshot: ServerProviderUsageSnapshot | undefined,
  hasUsageLines: boolean,
): string {
  switch (snapshot?.status) {
    case "needs-auth":
      return "Sign in";
    case "unsupported":
      return "Unsupported";
    case "error":
      return "Unavailable";
    default:
      return hasUsageLines ? "Connected" : "No data";
  }
}

export function resolveEnvironmentProviderUsageSummary(input: {
  readonly providerName: string;
  readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
  /** Account-specific live snapshot, or an absent snapshot on legacy provider surfaces. */
  readonly snapshot: ServerProviderUsageSnapshot | undefined;
  readonly hasUsageLines: boolean;
  readonly hasResetCredits?: boolean;
}): EnvironmentProviderUsageSummary {
  const statusLabel = providerUsageStatusLabel(
    input.snapshot,
    input.hasUsageLines || input.hasResetCredits === true,
  );
  const rowSummary = input.rows
    .map((row) => `${row.label} ${row.remainingLabel} remaining`)
    .join(", ");

  return {
    rows: input.rows,
    statusLabel,
    ariaLabel: `${input.providerName} usage: ${rowSummary || statusLabel}`,
  };
}
