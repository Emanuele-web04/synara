// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — a compact menu per account of the active provider.

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ProviderKind,
  type ServerProviderUsageSnapshot,
} from "@synara/contracts";
import {
  deriveProviderInstances,
  type ResolvedProviderInstance,
} from "@synara/shared/providerInstances";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";

import {
  ProviderUsageMenuPopup,
  useProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";
import { formatRateLimitMessage, type RateLimitStatus } from "~/lib/rateLimitStatus";
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
import { useTranslation } from "~/i18n";

function EnvironmentUsageAccountRow({
  instance,
  snapshot,
  label,
  rateLimitStatus,
}: {
  instance: ResolvedProviderInstance;
  snapshot: ServerProviderUsageSnapshot | undefined;
  label: string;
  rateLimitStatus: RateLimitStatus | null;
}) {
  const { t, formatLocale } = useTranslation();
  const provider = instance.driver;
  const model = useProviderUsageMenuModel(provider, {
    instanceId: instance.instanceId,
    providerSnapshot: snapshot,
  });
  const summary = resolveEnvironmentProviderUsageSummary(
    {
      providerName: label,
      rows: model.rows,
      snapshot,
      hasUsageLines: model.usageLines.length > 0,
    },
    t,
  );

  const warning = rateLimitStatus ? formatRateLimitMessage(rateLimitStatus, t, formatLocale) : null;

  return (
    <ProviderUsageMenuPopup provider={provider} model={model} align="start" showUsageLines={true}>
      <MenuTrigger
        render={
          <button
            type="button"
            className={ENVIRONMENT_ROW_CLASS_NAME}
            aria-label={
              warning
                ? t("settings:usageProviderSummary", { provider: label, summary: warning })
                : summary.ariaLabel
            }
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
          label={
            warning ? (
              <span className="flex flex-col gap-0.5">
                <span>{label}</span>
                <span className="whitespace-normal text-ui-xs text-warning">{warning}</span>
              </span>
            ) : (
              label
            )
          }
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
              ) : warning ? null : (
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

export function EnvironmentUsageSection({
  provider,
  activeInstanceId,
  rateLimitStatus = null,
}: {
  provider: ProviderKind;
  activeInstanceId?: string | undefined;
  rateLimitStatus?: RateLimitStatus | null | undefined;
}) {
  const { t } = useTranslation();

  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const providerInstances = deriveProviderInstances(
    settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW,
  ).filter((instance) => instance.enabled && instance.driver === provider);
  const accounts = providerInstances.flatMap((instance) => {
    const snapshot = usageQuery.data?.find(
      (entry) =>
        entry.provider === provider && (entry.instanceId ?? entry.provider) === instance.instanceId,
    );
    const accountRateLimitStatus =
      instance.instanceId === (activeInstanceId ?? provider) ? rateLimitStatus : null;
    if (!snapshot && !accountRateLimitStatus) return [];
    const hasUsage =
      (snapshot?.limits.length ?? 0) > 0 ||
      (snapshot?.usageLines.length ?? 0) > 0 ||
      (snapshot?.resetCredits?.availableCount ?? 0) > 0;
    // Unused default providers should not crowd the panel. Configured extra
    // accounts stay visible so an expired login or failed usage check is clear.
    if (
      instance.isDefault &&
      providerInstances.length === 1 &&
      !instance.raw.displayName &&
      !hasUsage &&
      !accountRateLimitStatus &&
      (snapshot?.status === "needs-auth" || (snapshot?.status ?? "ok") === "ok")
    )
      return [];
    const providerName = providerUsageDisplayName(provider);
    const showAccountName =
      !instance.isDefault || providerInstances.length > 1 || instance.displayName !== providerName;
    const accountName =
      instance.isDefault && instance.displayName === providerName
        ? "Default"
        : instance.displayName;
    return [
      {
        instance,
        snapshot,
        accountRateLimitStatus,
        label: showAccountName
          ? t("common:symbol9", { value0: providerName, value1: accountName })
          : providerName,
      },
    ];
  });

  if (accounts.length === 0) return null;

  return (
    <EnvironmentLabeledSection label={t("chat:general_usage")}>
      {accounts.map(({ instance, snapshot, label, accountRateLimitStatus }) => (
        <EnvironmentUsageAccountRow
          key={instance.instanceId}
          instance={instance}
          snapshot={snapshot}
          label={label}
          rateLimitStatus={accountRateLimitStatus}
        />
      ))}
    </EnvironmentLabeledSection>
  );
}
