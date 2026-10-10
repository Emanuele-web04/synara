import type { ProviderInstanceId, ProviderKind } from "@synara/contracts";

/** Provider-wide external-server credentials belong only to the canonical default instance. */
export function canUseDefaultOpenCodeServerPassword(
  provider: ProviderKind,
  instanceId: ProviderInstanceId | string | undefined,
): boolean {
  return instanceId === undefined || instanceId === provider;
}
