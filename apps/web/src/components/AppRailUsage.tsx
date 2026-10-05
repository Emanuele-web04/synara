// FILE: AppRailUsage.tsx
// Purpose: Provider usage rings at the bottom of the app rail, above Help: the provider glyph inside a
//          remaining-quota ring, a hover card with every limit, click opens Settings → Usage.
// Layer: App shell component
// Depends on: the shared provider-usage menu model and panel content, so the rail reads the
//             same numbers as the chat header chip, the Environment panel, and Settings.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";

import { useAppSettings, type RailUsageWindow } from "~/appSettings";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";

import { appRailButtonClassName } from "./AppRail";
import {
  railUsageRingTone,
  resolveRailUsageProviders,
  selectRailUsageRows,
  type RailUsageRingTone,
} from "./AppRailUsage.logic";
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
import { StatusChip } from "./ui/status-chip";

// Every ring uses the same scale, so its colour alone says how much is left.
const RING_TONE_CLASS_NAME: Record<RailUsageRingTone, { stroke: string; dot: string }> = {
  healthy: { stroke: "stroke-emerald-500", dot: "bg-emerald-500" },
  fair: { stroke: "stroke-yellow-500", dot: "bg-yellow-500" },
  low: { stroke: "stroke-orange-500", dot: "bg-orange-500" },
  critical: { stroke: "stroke-red-500", dot: "bg-red-500" },
};

// Geometry in px inside the rail's 36px button. Two tracks take a larger box, thinner
// strokes and a smaller glyph, so the tracks keep a 2.25px gap and the glyph clears the
// inner one.
const SINGLE_RING = { size: 28, stroke: 2.5, svgClassName: "size-7", iconClassName: "size-3.5" };
const DOUBLE_RING = { size: 34, stroke: 2.25, svgClassName: "size-8.5", iconClassName: "size-3" };
const RING_SPACING = 4.5;

function AppRailUsageRing({
  provider,
  snapshot,
  window,
  onOpenUsageSettings,
}: {
  provider: ProviderKind;
  snapshot: ServerProviderUsageSnapshot | undefined;
  window: RailUsageWindow;
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
  const rings = selectRailUsageRows(model.rows, model.primaryRow, window).map((row) => ({
    row,
    tone: RING_TONE_CLASS_NAME[railUsageRingTone(row.remainingPercent)],
  }));
  const ring = rings.length > 1 ? DOUBLE_RING : SINGLE_RING;
  const outerRadius = (ring.size - ring.stroke) / 2;

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
          viewBox={`0 0 ${ring.size} ${ring.size}`}
          className={cn("-rotate-90", ring.svgClassName)}
          fill="none"
          aria-hidden
        >
          {rings.length === 0 ? (
            <circle
              cx={ring.size / 2}
              cy={ring.size / 2}
              r={outerRadius}
              strokeWidth={ring.stroke}
              className="stroke-current opacity-15"
            />
          ) : null}
          {rings.map(({ row, tone }, index) => (
            <g key={row.id}>
              <circle
                cx={ring.size / 2}
                cy={ring.size / 2}
                r={outerRadius - index * RING_SPACING}
                strokeWidth={ring.stroke}
                className="stroke-current opacity-15"
              />
              {row.remainingPercent > 0 ? (
                <circle
                  cx={ring.size / 2}
                  cy={ring.size / 2}
                  r={outerRadius - index * RING_SPACING}
                  strokeWidth={ring.stroke}
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray={`${row.remainingPercent} 100`}
                  className={cn(
                    "transition-[stroke-dasharray] duration-500 motion-reduce:transition-none",
                    tone.stroke,
                  )}
                />
              ) : null}
            </g>
          ))}
        </svg>
        <ProviderIcon
          provider={provider}
          className={cn("absolute", ring.iconClassName, unavailable && "opacity-50")}
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
          {rings.length > 1 ? (
            <div className="flex items-center gap-3 text-muted-foreground">
              {rings.map(({ row, tone }, index) => (
                <StatusChip key={row.id} dotClassName={tone.dot}>
                  {row.label} · {index === 0 ? "outer" : "inner"}
                </StatusChip>
              ))}
            </div>
          ) : null}
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

/** Sits above Help: a ring per provider, with the windows chosen in Settings → Usage. */
export function AppRailUsage({ onOpenUsageSettings }: { onOpenUsageSettings: () => void }) {
  const { settings } = useAppSettings();
  const providers = resolveRailUsageProviders(
    settings.railUsageProviders,
    settings.disabledProviders,
  );
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
          window={settings.railUsageWindow}
          onOpenUsageSettings={onOpenUsageSettings}
        />
      ))}
    </>
  );
}
