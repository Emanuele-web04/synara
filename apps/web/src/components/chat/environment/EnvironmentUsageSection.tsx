// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — a compact menu per provider account.

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ProviderKind,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import {
  deriveProviderInstances,
  type ResolvedProviderInstance,
} from "@synara/shared/providerInstances";
import { PROVIDER_USAGE_PROVIDERS, providerUsageDisplayName } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";

import {
  ProviderUsageMenuPopup,
  useProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";
import { ProviderIcon } from "~/components/ProviderIcon";
import { MenuTrigger } from "~/components/ui/menu";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";

import { resolveEnvironmentProviderUsageSummary } from "./EnvironmentUsageSection.logic";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

function EnvironmentUsageAccountRow({
  instance,
  snapshot,
  label,
}: {
  instance: ResolvedProviderInstance;
  snapshot: ServerProviderUsageSnapshot;
  label: string;
}) {
  const provider = instance.driver;
  const model = useProviderUsageMenuModel(provider, {
    instanceId: instance.instanceId,
    providerSnapshot: snapshot,
  });
  const summary = resolveEnvironmentProviderUsageSummary({
    providerName: label,
    rows: model.rows,
    snapshot,
    hasUsageLines: model.usageLines.length > 0,
  });

  return (
    <ProviderUsageMenuPopup provider={provider} model={model} align="start" showUsageLines={true}>
      <MenuTrigger
        render={
          <button
            type="button"
            className={ENVIRONMENT_ROW_CLASS_NAME}
            aria-label={summary.ariaLabel}
          />
        }
      >
        <EnvironmentRowBody
          icon={
            <ProviderIcon
              provider={provider}
              tone="header"
              className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
            />
          }
          label={label}
          trailing={
            <span className="flex items-center gap-1.5">
              {summary.rows.length > 0 ? (
                <span className="flex flex-col items-end gap-0.5 text-ui-xs leading-none">
                  {summary.rows.map((row) => (
                    <span key={row.id} className="flex items-baseline gap-1.5">
                      <span className="text-[var(--color-text-foreground-secondary)]">
                        {row.label}
                      </span>
                      <span className="min-w-7 text-right text-[var(--color-text-foreground)]">
                        {row.remainingLabel}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-ui-xs text-[var(--color-text-foreground-secondary)]">
                  {summary.statusLabel}
                </span>
              )}
              <EnvironmentRowChevron />
            </span>
          }
        />
      </MenuTrigger>
    </ProviderUsageMenuPopup>
  );
}

export function EnvironmentUsageSection({ provider }: { provider: ProviderKind }) {
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const instances = deriveProviderInstances(
    settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW,
  ).filter((instance) => instance.enabled);
  const providers = [provider, ...PROVIDER_USAGE_PROVIDERS.filter((entry) => entry !== provider)];
  const accounts = providers.flatMap((driver) => {
    const providerInstances = instances.filter((instance) => instance.driver === driver);
    return providerInstances.flatMap((instance) => {
      const snapshot = usageQuery.data?.find(
        (entry) =>
          entry.provider === driver && (entry.instanceId ?? entry.provider) === instance.instanceId,
      );
      if (!snapshot) return [];
      const hasUsage =
        snapshot.limits.length > 0 ||
        snapshot.usageLines.length > 0 ||
        (snapshot.resetCredits?.availableCount ?? 0) > 0;
      // Unused default providers should not crowd the panel. Configured extra
      // accounts stay visible so an expired login or failed usage check is clear.
      if (
        instance.isDefault &&
        providerInstances.length === 1 &&
        !instance.raw.displayName &&
        !hasUsage &&
        (snapshot.status === "needs-auth" || (snapshot.status ?? "ok") === "ok")
      )
        return [];
      const providerName = providerUsageDisplayName(driver);
      const showAccountName =
        !instance.isDefault ||
        providerInstances.length > 1 ||
        instance.displayName !== providerName;
      const accountName =
        instance.isDefault && instance.displayName === providerName
          ? "Default"
          : instance.displayName;
      return [
        {
          instance,
          snapshot,
          label: showAccountName ? `${providerName} · ${accountName}` : providerName,
        },
      ];
    });
  });

  if (accounts.length === 0) return null;

  return (
    <EnvironmentLabeledSection label="Usage">
      {accounts.map(({ instance, snapshot, label }) => (
        <EnvironmentUsageAccountRow
          key={instance.instanceId}
          instance={instance}
          snapshot={snapshot}
          label={label}
        />
      ))}
    </EnvironmentLabeledSection>
  );
}
