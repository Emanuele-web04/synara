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
  // Missing CLIs and failed probes both report available=false. The server's
  // message supplies the specific diagnosis alongside this label in Settings.
  if (!status.available) return "Unavailable";
  if (status.authStatus === "unauthenticated") return "Needs sign-in";
  if (status.status !== "ready") return "Needs attention";
  if (status.authStatus === "unknown") return "Installed · sign-in not verified";
  return "Connected";
}

export type ProviderAccountStatusTone = "ready" | "warning" | "error" | "idle";

export interface ProviderAccountStatusSummary {
  readonly tone: ProviderAccountStatusTone;
  /** Short state title shown on the account's row. */
  readonly headline: string;
  /** The server's diagnosis, when it adds something the headline does not say. */
  readonly detail: string | null;
}

// One title per account row. The local switch wins over a stale status: an account that
// was just turned off reads "Disabled" before the server reports it.
export function providerAccountStatusSummary(input: {
  readonly status: ServerProviderStatus | undefined;
  readonly enabled: boolean;
}): ProviderAccountStatusSummary {
  if (!input.enabled) {
    return { tone: "idle", headline: "Disabled", detail: null };
  }
  const status = input.status;
  if (!status) {
    return { tone: "idle", headline: "Checking account status", detail: null };
  }
  const detail = status.message?.trim() || null;
  if (!status.available) {
    return { tone: "error", headline: "Unavailable", detail };
  }
  if (status.authStatus === "unauthenticated") {
    return { tone: "warning", headline: "Not authenticated", detail };
  }
  if (status.status === "error") {
    return { tone: "error", headline: "Unavailable", detail };
  }
  if (status.status === "warning") {
    return { tone: "warning", headline: "Needs attention", detail };
  }
  if (status.authStatus === "authenticated") {
    const authLabel = status.authLabel?.trim() || status.authType?.trim();
    return {
      tone: "ready",
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail,
    };
  }
  return { tone: "ready", headline: "Available", detail };
}
