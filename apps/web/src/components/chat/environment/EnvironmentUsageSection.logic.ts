// FILE: EnvironmentUsageSection.logic.ts
// Purpose: Pure compact-summary decisions for provider rows in the Environment panel.

import { t } from "~/i18n";
import { rateLimitWindowDisplayLabel } from "~/lib/rateLimits";
import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";

export interface EnvironmentProviderUsageSummary {
  readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
  readonly statusLabel: string;
  readonly ariaLabel: string;
}

function providerUsageStatusLabel(
  snapshot: ServerProviderUsageSnapshot | undefined,
  hasUsageLines: boolean,
  translate: typeof t,
): string {
  switch (snapshot?.status) {
    case "needs-auth":
      return translate("chat:providerModelPicker_signIn");
    case "unsupported":
      return translate("chat:providerUsage_unsupported");
    case "error":
      return translate("chat:providerModelPicker_unavailable");
    default:
      return hasUsageLines ? translate("chat:connected") : translate("settings:usageNoData");
  }
}

export function resolveEnvironmentProviderUsageSummary(
  input: {
    readonly providerName: string;
    readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
    /** Live batch snapshot when available; the row renders without one (local/thread fallbacks). */
    readonly snapshot: ServerProviderUsageSnapshot | undefined;
    readonly hasUsageLines: boolean;
  },
  translate: typeof t = t,
): EnvironmentProviderUsageSummary {
  const statusLabel = providerUsageStatusLabel(input.snapshot, input.hasUsageLines, translate);
  const rowSummary = input.rows
    .map((row) =>
      translate("settings:usageWindowRemaining", {
        window: rateLimitWindowDisplayLabel(row.label, translate),
        amount: row.remainingLabel,
      }),
    )
    .join(", ");

  return {
    rows: input.rows,
    statusLabel,
    ariaLabel: translate("settings:usageProviderSummary", {
      provider: input.providerName,
      summary: rowSummary || statusLabel,
    }),
  };
}
