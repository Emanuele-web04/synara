// FILE: ProviderUsageSettingsPanel.tsx
// Purpose: Settings → Usage panel. One card per supported provider account showing live remaining
// quota/credits with linear progress meters, the provider brand icon, and plan/status pills.
// Usage is fetched read-only from each CLI's stored credentials by the server.

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import {
  providerUsageDisplayName,
  providerUsageNeedsAuthDetail,
  selectVisibleProviderUsageSnapshots,
} from "@synara/shared/providerUsage";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppSettings, type RailUsageWindow } from "~/appSettings";
import {
  MAX_RAIL_USAGE_ACCOUNTS,
  getRailUsageAccounts,
  resolveRailUsageAccounts,
  toggleRailUsageAccount,
} from "~/components/AppRailUsage.logic";
import { ProviderAccountAvatar } from "~/components/ProviderAccountMark";
import { ProviderIcon } from "~/components/ProviderIcon";
import { ProviderUsageLimitRows } from "~/components/ProviderUsageLimitRows";
import { ProviderUsageLineList } from "~/components/ProviderUsageLineList";
import { ProviderUsageResetCredits } from "~/components/ProviderUsageResetCredits";
import {
  SettingsCard,
  SettingsListRow,
  SettingsSection,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { SettingsSegmentedControl } from "~/components/settings/SettingControls";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { RotateCcwIcon, TriangleAlertIcon } from "~/lib/icons";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import {
  fetchAllProviderUsage,
  serverAllProviderUsageQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

const RAIL_USAGE_WINDOW_OPTIONS = [
  { value: "both", label: "Both" },
  { value: "fiveHour", label: "5h" },
  { value: "weekly", label: "Weekly" },
] as const satisfies ReadonlyArray<{ value: RailUsageWindow; label: string }>;

const PILL_CLASS_NAME = "shrink-0 rounded-full px-2 py-1 text-ui-sm font-medium leading-none";

interface StatusPill {
  label: string;
  className: string;
}

function statusPill(status: ServerProviderUsageSnapshot["status"]): StatusPill | null {
  switch (status) {
    case "needs-auth":
      return {
        label: "Not signed in",
        className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      };
    case "unsupported":
      return { label: "Unsupported", className: "bg-muted text-muted-foreground" };
    case "error":
      return { label: "Unavailable", className: "bg-red-500/12 text-red-600 dark:text-red-400" };
    default:
      return null;
  }
}

function ProviderUsageCard({
  snapshot,
  accountLabel,
}: {
  snapshot: ServerProviderUsageSnapshot;
  accountLabel: string | null;
}) {
  const provider = snapshot.provider;
  const status = snapshot.status ?? "ok";
  const usageSummary = useProviderUsageSummary({
    provider,
    instanceId: snapshot.instanceId ?? provider,
    providerSnapshot: snapshot,
  });
  const meterRows = deriveProviderUsageDisplayRows(usageSummary.rateLimits);
  const usageLines = usageSummary.usageLines;
  const resetCredits = provider === "codex" ? snapshot.resetCredits : undefined;
  const hasResetCredits = Boolean(resetCredits && resetCredits.availableCount > 0);
  const hasUsage = meterRows.length > 0 || usageLines.length > 0 || hasResetCredits;
  const pill = status === "ok" ? null : statusPill(snapshot.status);

  return (
    <SettingsCard>
      <div className="space-y-3.5 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] bg-muted/60">
              <ProviderIcon provider={provider} className="size-4" />
            </span>
            <div className="min-w-0 space-y-0.5">
              <span className="block truncate text-ui-lg font-semibold text-foreground">
                {providerUsageDisplayName(provider)}
              </span>
              {accountLabel ? (
                <p className="truncate text-ui-sm text-muted-foreground" title={accountLabel}>
                  {accountLabel}
                </p>
              ) : null}
            </div>
          </div>
          {status === "ok" && snapshot.planName ? (
            <span className={cn(PILL_CLASS_NAME, "bg-muted text-muted-foreground")}>
              {snapshot.planName}
            </span>
          ) : pill ? (
            <span className={cn(PILL_CLASS_NAME, pill.className)}>{pill.label}</span>
          ) : null}
        </div>

        {status === "ok" && hasUsage ? (
          <>
            {usageSummary.usageNotice ? (
              <p className="flex items-start gap-1.5 text-ui leading-relaxed text-amber-600 dark:text-amber-300/90">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{usageSummary.usageNotice}</span>
              </p>
            ) : null}
            {meterRows.length > 0 ? (
              <ProviderUsageLimitRows rows={meterRows} surface="settings" />
            ) : null}
            {hasResetCredits && resetCredits ? (
              <ProviderUsageResetCredits resetCredits={resetCredits} />
            ) : null}
            {usageLines.length > 0 ? (
              <ProviderUsageLineList
                className={cn(
                  (meterRows.length > 0 || hasResetCredits) &&
                    "border-t border-[color:var(--color-border)] pt-3",
                )}
                lines={usageLines}
                surface="settings"
              />
            ) : null}
          </>
        ) : (
          <p className="text-ui leading-relaxed text-muted-foreground">
            {status === "ok"
              ? "No usage data reported yet."
              : (snapshot.detail ?? providerUsageNeedsAuthDetail(provider))}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}

export function ProviderUsageSettingsPanel() {
  const queryClient = useQueryClient();
  const { settings, updateSettings } = useAppSettings();
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const providerInstances = useMemo(
    () =>
      new Map(
        deriveProviderInstances(serverSettingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW).map(
          (instance) => [instance.instanceId, instance],
        ),
      ),
    [serverSettingsQuery.data],
  );
  const railUsageAccounts = getRailUsageAccounts([...providerInstances.values()]);
  const railUsageInstanceIds = resolveRailUsageAccounts(
    settings.railUsageInstanceIds ?? settings.railUsageProviders,
    railUsageAccounts,
  ).map((account) => account.instance.instanceId);
  const railUsageFull = railUsageInstanceIds.length >= MAX_RAIL_USAGE_ACCOUNTS;
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const refreshMutation = useMutation({
    mutationFn: () => fetchAllProviderUsage({ forceRefresh: true }),
    onSuccess: (data) => {
      // The batch owns account membership. Keeping omitted previous snapshots
      // would restore accounts that were removed or disabled since the last fetch.
      queryClient.setQueryData<readonly ServerProviderUsageSnapshot[]>(
        serverQueryKeys.allProviderUsage(),
        data,
      );
    },
  });

  // Use the live payload only. Inventing error placeholders for omitted providers
  // would count as "connected" and hide unsigned cards.
  // Loaded settings remove stale cached accounts immediately while a fresh
  // batch is still in flight. Keep cached usage visible until settings arrive.
  const activeSnapshots = serverSettingsQuery.data
    ? (usageQuery.data ?? []).filter((snapshot) => {
        const instance = providerInstances.get(snapshot.instanceId ?? snapshot.provider);
        return instance?.enabled === true && instance.driver === snapshot.provider;
      })
    : (usageQuery.data ?? []);
  const cards = selectVisibleProviderUsageSnapshots(activeSnapshots);

  const showInitialLoading = usageQuery.isPending && !usageQuery.data;

  const isRefreshing = usageQuery.isFetching || refreshMutation.isPending;

  return (
    <>
      <SettingsSection title={`Sidebar · up to ${MAX_RAIL_USAGE_ACCOUNTS} accounts`}>
        {railUsageAccounts.map(({ instance, label }) => {
          const checked = railUsageInstanceIds.includes(instance.instanceId);
          return (
            <SettingsListRow
              key={instance.instanceId}
              title={
                <span className="flex items-center gap-2">
                  <ProviderAccountAvatar
                    provider={instance.driver}
                    accentColor={instance.raw.accentColor}
                    className="size-6"
                  />
                  <span className="truncate">{label}</span>
                </span>
              }
              actions={
                <Switch
                  checked={checked}
                  disabled={serverSettingsQuery.isPending || (!checked && railUsageFull)}
                  onCheckedChange={(next) =>
                    updateSettings({
                      railUsageInstanceIds: toggleRailUsageAccount(
                        railUsageInstanceIds,
                        instance.instanceId,
                        Boolean(next),
                      ),
                    })
                  }
                  aria-label={`Show ${label} usage at the bottom of the sidebar`}
                />
              }
            />
          );
        })}
        <SettingsListRow
          title="Ring"
          description="Show both limits as two rings, or a single ring for one of them."
          actions={
            <SettingsSegmentedControl
              value={settings.railUsageWindow}
              onValueChange={(value) => updateSettings({ railUsageWindow: value })}
              ariaLabel="Sidebar usage ring"
              options={RAIL_USAGE_WINDOW_OPTIONS}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Usage popovers">
        <SettingsListRow
          title="Show details by default"
          description="Open the details below the limits. When off, they stay behind the Details toggle; your last toggle also updates this preference."
          actions={
            <Switch
              checked={settings.usageDetailsDefaultOpen}
              onCheckedChange={(next) => updateSettings({ usageDetailsDefaultOpen: Boolean(next) })}
              aria-label="Show usage details by default in usage popovers"
            />
          }
        />
        <SettingsListRow
          title="Banked resets"
          description="Include Codex banked resets in the details."
          actions={
            <Switch
              checked={settings.usagePopoverShowResetCredits}
              onCheckedChange={(next) =>
                updateSettings({ usagePopoverShowResetCredits: Boolean(next) })
              }
              aria-label="Show banked resets in usage popovers"
            />
          }
        />
        <SettingsListRow
          title="Credits and token totals"
          description="Include credit balances and recent token totals (24h, 7d, 30d) in the details."
          actions={
            <Switch
              checked={settings.usagePopoverShowUsageLines}
              onCheckedChange={(next) =>
                updateSettings({ usagePopoverShowUsageLines: Boolean(next) })
              }
              aria-label="Show credits and token totals in usage popovers"
            />
          }
        />
      </SettingsSection>
      <SettingsSectionShell
        title="Provider usage"
        action={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={isRefreshing}
            onClick={() => refreshMutation.mutate()}
          >
            <RotateCcwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      >
        {showInitialLoading ? (
          <SettingsCard>
            <div className="px-4 py-3.5 text-ui leading-snug text-muted-foreground">
              Loading provider usage…
            </div>
          </SettingsCard>
        ) : (
          <div className="flex flex-col gap-3">
            {cards.map((snapshot) => {
              const instanceId = snapshot.instanceId ?? snapshot.provider;
              const instance = providerInstances.get(instanceId);
              const accountLabel =
                instanceId !== snapshot.provider
                  ? (instance?.displayName ?? instanceId)
                  : instance?.raw.displayName?.trim() ||
                    (snapshot.instanceId ? "Default account" : null);
              return (
                <ProviderUsageCard
                  key={instanceId}
                  snapshot={snapshot}
                  accountLabel={accountLabel}
                />
              );
            })}
          </div>
        )}

        <p className="px-2 text-ui-sm leading-relaxed text-muted-foreground">
          Usage is read locally from each provider CLI&apos;s stored credentials and fetched
          directly from the provider. The list follows whatever you are signed into; unsigned
          providers stay visible until any account is connected, then drop away. Short-lived tokens
          are refreshed through the provider&apos;s own CLI or official token endpoint.
        </p>
      </SettingsSectionShell>
    </>
  );
}
