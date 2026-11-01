import { t } from "~/i18n";
import type { ServerProviderStatus, ServerProviderUsageSnapshot } from "@synara/contracts";

/** Installation/auth health is independent of permission to run background work. */
export function providerSetupStatusLabel(
  input: {
    readonly status: ServerProviderStatus | undefined;
    readonly reconciled: boolean;
    readonly disabled: boolean;
  },
  translate: typeof t = t,
): string {
  if (input.disabled) return translate("settings:accountDisabledSetup");
  if (!input.reconciled || !input.status) return translate("settings:checkingSetup");
  const status = input.status;
  // Missing CLIs and failed probes both report available=false. The server's
  // message supplies the specific diagnosis alongside this label in Settings.
  if (!status.available) return translate("chat:providerModelPicker_unavailable");
  if (status.authStatus === "unauthenticated") return translate("common:needsSignIn");
  if (status.status !== "ready") return translate("common:triageOutcome_needsAttention");
  if (status.authStatus === "unknown") {
    return (status.driver ?? status.provider) === "opencode"
      ? translate("settings:accountInstalledOpenCode")
      : translate("settings:accountInstalledUnverified");
  }
  return translate("chat:connected");
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
// was just turned off reads translate("chat:disabled") before the server reports it.
export function providerAccountStatusSummary(
  input: {
    readonly status: ServerProviderStatus | undefined;
    readonly enabled: boolean;
    readonly usageSnapshot?: ServerProviderUsageSnapshot | undefined;
  },
  translate: typeof t = t,
): ProviderAccountStatusSummary {
  if (!input.enabled) {
    return { tone: "idle", headline: translate("chat:disabled"), detail: null };
  }
  const status = input.status;
  if (!status) {
    return { tone: "idle", headline: translate("settings:accountCheckingStatus"), detail: null };
  }
  const detail = status.message?.trim() || null;
  if (!status.available) {
    return { tone: "error", headline: translate("chat:providerModelPicker_unavailable"), detail };
  }
  if (status.authStatus === "unauthenticated") {
    return { tone: "warning", headline: translate("settings:accountNotAuthenticated"), detail };
  }
  if (status.status === "error") {
    return { tone: "error", headline: translate("chat:providerModelPicker_unavailable"), detail };
  }
  if (status.status === "warning") {
    return { tone: "warning", headline: translate("common:triageOutcome_needsAttention"), detail };
  }
  if (status.authStatus === "authenticated") {
    const claude = (status.driver ?? status.provider) === "claudeAgent";
    const usage = input.usageSnapshot;
    if (claude && usage && (usage.status === "needs-auth" || usage.status === "error")) {
      return {
        tone: "warning",
        headline: translate("settings:accountUsageNeedsAttention"),
        detail: usage.detail ?? translate("settings:accountClaudeUsageUnverified"),
      };
    }
    const authLabel = status.authLabel?.trim() || status.authType?.trim();
    const headline = claude
      ? translate("settings:accountSignedInLocally")
      : translate("settings:accountAuthenticated");
    return {
      tone: "ready",
      headline: authLabel ? `${headline} · ${authLabel}` : headline,
      detail,
    };
  }
  return { tone: "ready", headline: translate("chat:available"), detail };
}
