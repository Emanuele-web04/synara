// FILE: AppRailUsage.tsx
// Purpose: Provider usage rings at the bottom of the app rail, above Help: the provider glyph inside a
//          remaining-quota ring, a hover card with every limit, click opens Settings → Usage.
// Layer: App shell component
// Depends on: the shared provider-usage menu model and panel content, so the rail reads the
//             same numbers as the chat header chip, the Environment panel, and Settings.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";

import { useAppSettings } from "~/appSettings";
import type { ProviderUsageTone } from "~/lib/providerUsageDisplay";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

import { appRailButtonClassName } from "./AppRail";
import { resolveRailUsageProviders } from "./AppRailUsage.logic";
import { resolveEnvironmentProviderUsageSummary } from "./chat/environment/EnvironmentUsageSection.logic";
import { ProviderIcon } from "./ProviderIcon";
import { useProviderUsageMenuModel } from "./ProviderUsageMenuControl";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";

const RING_TONE_CLASS_NAME: Record<ProviderUsageTone, string> = {
  healthy: "stroke-emerald-500",
  warning: "stroke-amber-500",
  danger: "stroke-red-500",
};

// The ring's box is 28 units; the stroke sits inside it, like Sidekick's AIUsageRing.
const RING_SIZE = 28;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;

function AppRailUsageRing({
  provider,
  snapshot,
  onOpenUsageSettings,
}: {
  provider: ProviderKind;
  snapshot: ServerProviderUsageSnapshot | undefined;
  onOpenUsageSettings: () => void;
}) {
  const model = useProviderUsageMenuModel(provider, { providerSnapshot: snapshot });

  // A failed fetch keeps a dimmed, empty ring (its card says why) so a chosen provider does
  // not vanish on a network blip. Otherwise nothing displayable (still loading, signed out,
  // or no usage source) means no ring.
  const unavailable = snapshot?.status === "error";
  if (!unavailable && model.rows.length === 0 && model.usageLines.length === 0) {
    return null;
  }

  const providerName = providerUsageDisplayName(provider);
  const summary = resolveEnvironmentProviderUsageSummary({
    providerName,
    rows: model.rows,
    snapshot,
    hasUsageLines: model.usageLines.length > 0,
  });
  // The tightest window drives the ring, as it does the chat header chip.
  const primaryRow = model.primaryRow;

  return (
    <PreviewCard>
      <PreviewCardTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <button
            type="button"
            aria-label={`${summary.ariaLabel}. Open usage settings`}
            className={cn(
              appRailButtonClassName(false),
              "relative flex shrink-0 items-center justify-center",
            )}
            onClick={onOpenUsageSettings}
          />
        }
      >
        <svg
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          className="size-7 -rotate-90"
          fill="none"
          aria-hidden
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            strokeWidth={RING_STROKE}
            className="stroke-current opacity-15"
          />
          {primaryRow ? (
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${primaryRow.remainingPercent} 100`}
              className={cn(
                "transition-[stroke-dasharray] duration-500",
                RING_TONE_CLASS_NAME[primaryRow.remainingTone],
              )}
            />
          ) : null}
        </svg>
        <ProviderIcon
          provider={provider}
          tone="header"
          className={cn("absolute size-3.5", unavailable && "opacity-50")}
        />
      </PreviewCardTrigger>
      <PreviewCardPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        // The rings sit at the rail's foot, so the card grows upward from them.
        align="end"
        sideOffset={6}
        className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
      >
        <div className="space-y-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-ui font-medium text-foreground">{providerName}</span>
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

/** Sits above the rail's Help button: one ring per provider chosen in Settings → Usage. */
export function AppRailUsage({ onOpenUsageSettings }: { onOpenUsageSettings: () => void }) {
  const { settings } = useAppSettings();
  const providers = resolveRailUsageProviders(settings.railUsageProviders);
  const usageQuery = useQuery(
    serverAllProviderUsageQueryOptions({ enabled: providers.length > 0 }),
  );
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const visibleProviders = providers.filter(
    (provider) => settingsQuery.data?.providers[provider].enabled !== false,
  );

  if (visibleProviders.length === 0) {
    return null;
  }

  return (
    <>
      {visibleProviders.map((provider) => (
        <AppRailUsageRing
          key={provider}
          provider={provider}
          snapshot={(usageQuery.data ?? []).find((entry) => entry.provider === provider)}
          onOpenUsageSettings={onOpenUsageSettings}
        />
      ))}
    </>
  );
}
