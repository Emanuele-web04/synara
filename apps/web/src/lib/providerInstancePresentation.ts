// FILE: providerInstancePresentation.ts
// Purpose: Gives identity-bearing provider-instance selections an explicit missing state.
// Layer: Web presentation helper

import type { ProviderInstanceId } from "@synara/contracts";

export const MISSING_PROVIDER_INSTANCE_LABEL = "Missing account";

export function resolveProviderInstanceLabel(
  instances: ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly label: string }>,
  selectedInstanceId: ProviderInstanceId,
): string {
  return (
    instances.find((instance) => instance.instanceId === selectedInstanceId)?.label ??
    MISSING_PROVIDER_INSTANCE_LABEL
  );
}
