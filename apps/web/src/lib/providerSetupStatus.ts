import type { ServerProviderStatus } from "@synara/contracts";

/** Installation/auth health is independent of permission to run background work. */
export function providerSetupStatusLabel(input: {
  readonly status: ServerProviderStatus | undefined;
  readonly reconciled: boolean;
  readonly disabled: boolean;
}): string {
  if (input.disabled) return "Disabled · enable to check setup";
  if (!input.reconciled || !input.status) return "Checking setup";
  const status = input.status;
  if (!status.available) return "Unavailable";
  if (status.authStatus === "unauthenticated") return "Needs sign-in";
  if (status.status !== "ready") return "Needs attention";
  if (status.authStatus === "unknown") return "Installed · sign-in not verified";
  return "Connected";
}
