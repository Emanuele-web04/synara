// FILE: ProfileUsageCoverage.tsx
// Purpose: Disclose missing provider telemetry beside profile rankings and exports.
// Layer: web profile feature.

import type { ProviderKind } from "@synara/contracts";
import { formatProviderLabel } from "./profileFormatting";

export function ProfileUsageCoverage({
  unavailableProviders,
  className = "text-xs text-muted-foreground",
}: {
  readonly unavailableProviders: ReadonlyArray<ProviderKind>;
  readonly className?: string;
}) {
  if (unavailableProviders.length === 0) {
    return null;
  }
  return (
    <p className={className}>
      Token data is unavailable for {unavailableProviders.map(formatProviderLabel).join(", ")}.{" "}
      Percentages reflect tracked tokens only. Their turns still count toward activity totals.
    </p>
  );
}
