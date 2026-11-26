// FILE: AppRailUsage.tsx
// Purpose: Provider quota tiles at the bottom of the app rail, above Help. Each tile shows
//          the tightest quota and opens Settings → Usage. Hover shows every limit.
// Layer: App shell component
// Depends on: the shared provider-usage menu model and panel content, so the rail reads the
//             same numbers as the chat header chip, the Environment panel, and Settings.

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { useQuery } from "@tanstack/react-query";

import { useAppSettings } from "~/appSettings";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

import { appRailButtonClassName } from "./AppRail";
import {
  getRailUsageAccounts,
  railUsageState,
  resolveRailUsageAccounts,
  type RailUsageAccount,
} from "./AppRailUsage.logic";
import { resolveEnvironmentProviderUsageSummary } from "./chat/environment/EnvironmentUsageSection.logic";
import { ProviderAccountDot } from "./ProviderAccountMark";
import { ProviderIcon } from "./ProviderIcon";
import { useProviderUsageMenuModel } from "./ProviderUsageMenuControl";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { useTranslation } from "~/i18n";

function AppRailUsageTile({
  account,
  snapshot,
  onOpenUsageSettings,
}: {
  account: RailUsageAccount;
  snapshot: ServerProviderUsageSnapshot | undefined;
  onOpenUsageSettings: () => void;
}) {
  const { t } = useTranslation();

  const { instance, label } = account;
  const provider = instance.driver;
  const model = useProviderUsageMenuModel(provider, {
    instanceId: instance.instanceId,
    providerSnapshot: snapshot ?? null,
  });

  // A failed fetch keeps the dimmed tile visible (its card says why) so a selected provider does
  // not vanish on a network blip; a tile with no quota reading draws an empty well, which reads
  // as "no reading yet" rather than as an exhausted account.
  const unavailable = snapshot?.status === "error";
  if (!unavailable && model.rows.length === 0 && model.usageLines.length === 0) {
    return null;
  }

  const summary = resolveEnvironmentProviderUsageSummary(
    {
      providerName: label,
      rows: model.rows,
      snapshot,
      hasUsageLines: model.usageLines.length > 0,
    },
    t,
  );
  const remainingPercent = model.primaryRow?.remainingPercent;
  const usageState = railUsageState(remainingPercent);

  return (
    <PreviewCard>
      <PreviewCardTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <button
            type="button"
            aria-label={t("common:openUsageSettings", { value0: summary.ariaLabel })}
            className={cn(
              appRailButtonClassName(false),
              "relative flex shrink-0 items-center justify-center",
            )}
            onClick={onOpenUsageSettings}
          />
        }
      >
        <span
          className="app-rail-usage-tile pointer-events-none absolute inset-0 rounded-[inherit]"
          data-usage-state={usageState}
          aria-hidden
        >
          <span className="app-rail-usage-well absolute inset-[3px] overflow-hidden rounded-[5px]">
            {remainingPercent !== undefined && remainingPercent > 0 ? (
              <span
                className="app-rail-usage-fill absolute inset-x-0 bottom-0 transition-[height] duration-500 motion-reduce:transition-none"
                style={{ height: `${remainingPercent}%` }}
              />
            ) : null}
          </span>
        </span>
        <span className="relative flex size-4">
          <ProviderIcon
            provider={provider}
            className={cn(
              "size-full",
              usageState === "exhausted" ? "opacity-35" : unavailable && "opacity-50",
            )}
          />
          <ProviderAccountDot
            accentColor={instance.raw.accentColor}
            always={account.dotted}
            className="absolute -top-0.5 -right-1 size-1.5 ring-0"
          />
        </span>
      </PreviewCardTrigger>
      <PreviewCardPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        // The tiles sit at the rail's foot, so the card grows upward from them.
        align="end"
        sideOffset={6}
        className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
      >
        <div className="space-y-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-ui font-medium text-foreground">{label}</span>
            {snapshot?.planName ? (
              <span className="shrink-0 text-ui-sm text-muted-foreground">{snapshot.planName}</span>
            ) : null}
          </div>
          <ProviderUsagePanelContent
            provider={provider}
            rateLimits={model.rateLimits}
            usageLines={model.usageLines}
            notice={model.notice}
            emptyMessage={model.emptyMessage}
            isLoading={model.isLoading}
            resetCredits={model.resetCredits}
            resetCreditsSurface="popover"
            showTitle={false}
          />
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}

/** Sits above Help with a quota tile per account selected in Settings → Usage. */
export function AppRailUsage({ onOpenUsageSettings }: { onOpenUsageSettings: () => void }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const accounts = resolveRailUsageAccounts(
    settings.railUsageInstanceIds ?? settings.railUsageProviders,
    getRailUsageAccounts(
      deriveProviderInstances(settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW),
      settings.disabledProviders,
      t,
    ),
  );
  const otherUsage = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: accounts.some(({ instance }) => instance.driver !== "antigravity"),
      scope: "other",
    }),
  );
  const antigravityUsage = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: accounts.some(({ instance }) => instance.driver === "antigravity"),
      scope: "antigravity",
    }),
  );

  if (accounts.length === 0) {
    return null;
  }

  return (
    <>
      {accounts.map((account) => (
        <AppRailUsageTile
          key={account.instance.instanceId}
          account={account}
          snapshot={(account.instance.driver === "antigravity"
            ? antigravityUsage.data
            : otherUsage.data
          )?.find(
            (entry) =>
              entry.provider === account.instance.driver &&
              (entry.instanceId ?? entry.provider) === account.instance.instanceId,
          )}
          onOpenUsageSettings={onOpenUsageSettings}
        />
      ))}
    </>
  );
}
