// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — a compact menu per enabled provider account.

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import {
  deriveProviderInstances,
  type ResolvedProviderInstance,
} from "@synara/shared/providerInstances";
import { useQueries, useQuery } from "@tanstack/react-query";

import { getRailUsageAccounts } from "~/components/AppRailUsage.logic";
import {
  ProviderUsageMenuPopup,
  useProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";
import { ProviderIcon } from "~/components/ProviderIcon";
import { MenuTrigger } from "~/components/ui/menu";
import {
  findProviderUsageAccountSnapshot,
  providerUsageAccountFallbackQueryOptions,
} from "~/lib/providerUsageAccountQueries";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";

import {
  resolveEnvironmentProviderUsageSummary,
  selectEnvironmentUsageAccounts,
} from "./EnvironmentUsageSection.logic";
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
    hasResetCredits: (model.resetCredits?.availableCount ?? 0) > 0,
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

export function EnvironmentUsageSection() {
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const providerInstances = deriveProviderInstances(
    settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW,
  );
  const enabledAccounts = getRailUsageAccounts(providerInstances);
  const batchSnapshots = usageQuery.data ?? [];
  const missingProviders = [
    ...new Set(
      enabledAccounts.flatMap(({ instance }) =>
        findProviderUsageAccountSnapshot(batchSnapshots, instance.driver, instance.instanceId)
          ? []
          : [instance.driver],
      ),
    ),
  ];
  const recoverMissingAccounts =
    settingsQuery.isSuccess && !usageQuery.isPending && !usageQuery.isFetching;
  const fallbackQueries = useQueries({
    queries: missingProviders.map((provider) =>
      providerUsageAccountFallbackQueryOptions({ provider, enabled: recoverMissingAccounts }),
    ),
  });
  const fallbackSnapshots = fallbackQueries.flatMap((query, index) => {
    // Cached recovery stays readable during a new shared batch; disabling its
    // request must not make an otherwise meaningful account row blink away.
    if (!query.isError) return query.data ?? [];
    // A failed recovery is an actual unavailable check, not a signed-in account
    // and not permission to borrow provider-wide archives or another account.
    return enabledAccounts.flatMap(({ instance }) =>
      instance.driver === missingProviders[index]
        ? [
            {
              provider: instance.driver,
              instanceId: instance.instanceId,
              updatedAt: new Date(query.errorUpdatedAt).toISOString(),
              limits: [],
              usageLines: [],
              source: "usage-query",
              status: "error" as const,
              detail: "Usage could not be read for this account.",
            },
          ]
        : [],
    );
  });
  const accounts = selectEnvironmentUsageAccounts({
    instances: providerInstances,
    snapshots: [...batchSnapshots, ...fallbackSnapshots],
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
