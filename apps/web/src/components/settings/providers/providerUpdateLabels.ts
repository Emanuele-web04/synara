// FILE: providerUpdateLabels.ts
// Purpose: Text for an agent CLI's version and update state: the version shown beside it,
//          the update outcome, the failure to report, and the name to report it under.
// Layer: Settings model
// Exports: formatProviderVersion, providerUpdateStatusLabel, providerUpdateFailureMessage,
//          providerStatusDisplayName

import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@synara/contracts";

import { t } from "~/i18n";
import { isProviderKind } from "~/providerOrdering";

export function formatProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function providerUpdateStatusLabel(provider: ServerProviderStatus): string | null {
  const state = provider.updateState?.status;
  if (state === "queued") return t("settings:updateQueued");
  if (state === "running") return t("settings:providers_updating");
  if (state === "succeeded") return t("common:updated");
  if (state === "failed") return t("common:providerUpdates_failed");
  if (state === "unchanged") return t("settings:stillOutdated");
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const currentVersion = formatProviderVersion(advisory.currentVersion);
    const latestVersion = formatProviderVersion(advisory.latestVersion);
    return currentVersion
      ? t("settings:symbol", { value0: currentVersion, value1: latestVersion })
      : t("settings:latest", { value0: latestVersion });
  }
  const currentVersion = formatProviderVersion(provider.version);
  return currentVersion ? t("settings:current", { value0: currentVersion }) : null;
}

export function providerUpdateFailureMessage(
  provider: ServerProviderStatus | undefined,
): string | null {
  const state = provider?.updateState;
  if (!state || (state.status !== "failed" && state.status !== "unchanged")) return null;
  return state.output?.trim() || state.message || t("settings:theProviderUpdateDidNotComplete");
}

export function providerStatusDisplayName(status: ServerProviderStatus): string {
  if (status.displayName?.trim()) return status.displayName;
  const driver = status.driver ?? status.provider;
  return isProviderKind(driver) ? PROVIDER_DISPLAY_NAMES[driver] : driver;
}
