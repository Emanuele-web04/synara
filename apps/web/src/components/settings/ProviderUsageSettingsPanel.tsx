// FILE: ProviderUsageSettingsPanel.tsx
// Purpose: Settings → Usage panel. One card per supported provider account showing live remaining
// quota/credits with linear progress meters, the provider brand icon, and plan/status pills.
// Usage is fetched read-only from each CLI's stored credentials by the server.

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerProviderUsageSnapshot,
  type ServerProviderUsageActivity,
  type ProviderKind,
} from "@synara/contracts";
import { ProviderUsageActivityCard } from "./ProviderUsageActivityCard";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import {
  providerUsageDisplayName,
  providerUsageNeedsAuthDetail,
  selectVisibleProviderUsageSnapshots,
} from "@synara/shared/providerUsage";
import { useMemo, useState } from "react";
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
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { formatCompact, formatNumber } from "~/components/profile/profileFormatting";
import { Switch } from "~/components/ui/switch";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { RotateCcwIcon, TriangleAlertIcon } from "~/lib/icons";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import {
  fetchAllProviderUsage,
  serverAllProviderUsageQueryOptions,
  serverProfileTokenStatsQueryOptions,
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

function formatActivityCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Not reported";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function ProviderUsageMachineActivity({
  activity,
  provider,
}: {
  activity: ServerProviderUsageActivity;
  provider: ProviderKind;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const breakdownId = `provider-machine-activity-breakdown-${provider}`;
  const period = activity.periods.find((entry) => entry.id === "30d") ?? activity.periods[0];
  if (!period) {
    return (
      <div className="rounded-lg border border-[color:var(--color-border)] bg-muted/20 px-3 py-2.5 text-ui text-muted-foreground">
        On this machine: {activity.detail ?? "no token-bearing sessions found in the last 30 days."}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-[color:var(--color-border)] bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-ui font-medium text-foreground">On this machine</p>
          <p className="mt-0.5 text-ui-sm text-muted-foreground">
            {activity.source.replace(/-local-sqlite$/u, " local history")} · measured tokens
          </p>
        </div>
        <span className={cn(PILL_CLASS_NAME, "bg-muted text-muted-foreground")}>30 days</span>
      </div>

      {activity.status === "partial" && activity.detail ? (
        <p className="flex items-start gap-1.5 text-ui-sm leading-relaxed text-amber-600 dark:text-amber-300/90">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{activity.detail}</span>
        </p>
      ) : null}

      <div className="grid grid-cols-3 divide-x divide-border/60 rounded-lg border border-border/60 bg-background/40">
        <div className="px-2 py-2 text-center">
          <p className="text-ui-lg font-semibold tabular-nums text-foreground">
            {formatCompact(period.tokens.total)}
          </p>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">tokens</p>
        </div>
        <div className="px-2 py-2 text-center">
          <p className="text-ui-lg font-semibold tabular-nums text-foreground">
            {formatNumber(period.sessions)}
          </p>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">sessions</p>
        </div>
        <div className="px-2 py-2 text-center">
          <p className="text-ui-lg font-semibold tabular-nums text-foreground">
            {formatActivityCost(period.recordedCostUsd)}
          </p>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">recorded cost</p>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        className="min-h-9 w-full justify-between px-1 text-ui text-muted-foreground hover:text-foreground"
        aria-expanded={detailsOpen}
        aria-controls={breakdownId}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <span>{detailsOpen ? "Hide model breakdown" : "View model breakdown"}</span>
        <DisclosureChevron open={detailsOpen} className="size-3.5" />
      </Button>
      <DisclosureRegion open={detailsOpen}>
        <div id={breakdownId} className="space-y-1.5 border-t border-border/60 pt-3">
          {activity.breakdown.slice(0, 8).map((entry) => (
            <div
              key={`${entry.upstreamProviderId ?? "direct"}:${entry.model}`}
              className="flex items-center justify-between gap-3 text-ui"
            >
              <span className="min-w-0 truncate text-foreground">
                {entry.upstreamProviderId ? `${entry.upstreamProviderId} · ` : ""}
                {entry.model}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatCompact(entry.tokens.total)} · {formatNumber(entry.sessions)} sessions
              </span>
            </div>
          ))}
        </div>
      </DisclosureRegion>
    </div>
  );
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
  const canShowAccountUsage = status === "ok" && hasUsage;
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

        {canShowAccountUsage ? (
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
              ? "No account usage data reported yet."
              : (snapshot.detail ?? providerUsageNeedsAuthDetail(provider))}
          </p>
        )}
        {snapshot.activity ? (
          <ProviderUsageMachineActivity provider={provider} activity={snapshot.activity} />
        ) : null}
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
  const railUsageAccounts = getRailUsageAccounts(
    [...providerInstances.values()],
    settings.disabledProviders,
  );
  // Disabled accounts keep their saved choice; only deleted accounts are discarded.
  const savedRailUsageInstanceIds = (
    settings.railUsageInstanceIds ?? settings.railUsageProviders
  ).filter((instanceId) => providerInstances.has(instanceId));
  const railUsageInstanceIds = resolveRailUsageAccounts(
    settings.railUsageInstanceIds ?? settings.railUsageProviders,
    railUsageAccounts,
  ).map((account) => account.instance.instanceId);
  const railUsageFull = railUsageInstanceIds.length >= MAX_RAIL_USAGE_ACCOUNTS;
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const tokenUsageQuery = useQuery(serverProfileTokenStatsQueryOptions());
  const refreshMutation = useMutation({
    mutationFn: () => fetchAllProviderUsage({ forceRefresh: true }),
    onSuccess: (data) => {
      // The batch owns account membership. Keeping omitted previous snapshots
      // would restore accounts that were removed or disabled since the last fetch.
      queryClient.setQueryData<readonly ServerProviderUsageSnapshot[]>(
        serverQueryKeys.allProviderUsage(),
        data,
      );
      void queryClient.invalidateQueries({
        queryKey: serverProfileTokenStatsQueryOptions().queryKey,
      });
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
  const cards = selectVisibleProviderUsageSnapshots(
    activeSnapshots.filter((snapshot) => !settings.disabledProviders.includes(snapshot.provider)),
  );

  const showInitialLoading = usageQuery.isPending && !usageQuery.data;

  const isRefreshing = usageQuery.isFetching || refreshMutation.isPending;

  const liveStatusCounts = cards.reduce(
    (counts, snapshot) => {
      const status: NonNullable<ServerProviderUsageSnapshot["status"]> = snapshot.status ?? "ok";
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    },
    {} as Partial<Record<NonNullable<ServerProviderUsageSnapshot["status"]>, number>>,
  );
  const providersWithLimits = cards.filter(
    (snapshot) => (snapshot.status ?? "ok") === "ok" && snapshot.limits.length > 0,
  ).length;
  const providersWithMachineActivity = cards.filter(
    (snapshot) => snapshot.activity?.status === "ok" || snapshot.activity?.status === "partial",
  ).length;
  const lastUpdated = cards.reduce((latest, snapshot) => {
    const time = Date.parse(snapshot.updatedAt);
    return Number.isNaN(time) || time <= latest ? latest : time;
  }, 0);
  const updatedLabel =
    lastUpdated > 0
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(lastUpdated))
      : "—";

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
                        savedRailUsageInstanceIds,
                        instance.instanceId,
                        Boolean(next),
                        railUsageAccounts,
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
        {!settings.disabledProviders.includes("codex") ? (
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
        ) : null}
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

function SummaryCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 bg-background px-3 py-2">
      <div className="truncate text-ui-lg font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 truncate text-ui-sm text-muted-foreground">{label}</div>
    </div>
  );
}
