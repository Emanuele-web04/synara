// FILE: providerUpdates.ts
// Purpose: Shared provider-update filtering and refresh cadence for global toasts and settings.
// Layer: Web settings/notification utility
// Exports: update candidate helpers, notification keys, and auto-refresh timing.

import type { ProviderKind, ServerProviderStatus, ServerSettings } from "@synara/contracts";

export const PROVIDER_UPDATE_INITIAL_REFRESH_DELAY_MS = 10_000;
export const PROVIDER_UPDATE_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;

type ProviderUpdateFilterInput = {
  readonly providers: ReadonlyArray<ServerProviderStatus>;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly serverSettings?:
    | Pick<ServerSettings, "providers" | "enableProviderUpdateChecks">
    | null
    | undefined;
  readonly oneClickOnly?: boolean;
};

type ProviderUpdateVisibilityInput = {
  readonly provider: ServerProviderStatus;
  readonly hiddenProviders?: ReadonlyArray<ProviderKind>;
  readonly hiddenProviderSet?: ReadonlySet<ProviderKind>;
  readonly serverSettings?:
    | Pick<ServerSettings, "providers" | "enableProviderUpdateChecks">
    | null
    | undefined;
  readonly oneClickOnly?: boolean;
};

export function isProviderUpdateActive(provider: ServerProviderStatus): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

function isProviderEnabled(
  provider: ProviderKind,
  serverSettings: Pick<ServerSettings, "providers"> | null | undefined,
): boolean {
  if (!serverSettings) {
    return false;
  }
  return serverSettings.providers[provider]?.enabled !== false;
}

// Central visibility gate used by both global toasts and Settings update rows.
export function shouldShowProviderUpdateStatus(input: ProviderUpdateVisibilityInput): boolean {
  const advisory = input.provider.versionAdvisory;
  const hiddenProviderSet = input.hiddenProviderSet ?? new Set(input.hiddenProviders ?? []);
  if (
    !advisory ||
    input.serverSettings?.enableProviderUpdateChecks === false ||
    advisory.status !== "behind_latest" ||
    advisory.latestVersion === null ||
    hiddenProviderSet.has(input.provider.provider) ||
    !isProviderEnabled(input.provider.provider, input.serverSettings)
  ) {
    return false;
  }

  return input.oneClickOnly === true
    ? advisory.canUpdate === true && advisory.updateCommand !== null
    : true;
}

export function getVisibleProviderUpdateStatuses(
  input: ProviderUpdateFilterInput,
): ServerProviderStatus[] {
  const hiddenProviderSet = new Set(input.hiddenProviders ?? []);
  const oneClickOnly = input.oneClickOnly ?? false;

  return input.providers.filter((provider) =>
    shouldShowProviderUpdateStatus({
      provider,
      serverSettings: input.serverSettings,
      hiddenProviderSet,
      oneClickOnly,
    }),
  );
}

export function providerUpdateNotificationKey(
  providers: ReadonlyArray<ServerProviderStatus>,
): string | null {
  const parts = providers
    .map((provider) =>
      [provider.provider, provider.versionAdvisory?.latestVersion ?? "unknown"].join(":"),
    )
    .toSorted();

  return parts.length > 0 ? parts.join("|") : null;
}
