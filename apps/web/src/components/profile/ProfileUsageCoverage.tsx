import type { ProviderKind } from "@synara/contracts";
import { formatProviderLabel } from "./profileFormatting";

export function ProfileUsageCoverage({
  unavailableProviders,
  className = "text-ui leading-snug text-muted-foreground",
}: {
  readonly unavailableProviders: ReadonlyArray<ProviderKind>;
  readonly className?: string;
}) {
  if (unavailableProviders.length === 0) {
    return null;
  }
  return (
    <p className={className}>
      Token usage is unavailable or zero for{" "}
      {unavailableProviders.map(formatProviderLabel).join(", ")}. Percentages reflect tracked tokens
      only. Their turns still count toward activity totals.
    </p>
  );
}
