// FILE: UsageAnalyticsPanel.tsx
// Purpose: The Usage Analytics tab: cost and tokens by day, provider, model, and
//          project, plus cache use, turn origin, and weekly rhythm, from Synara's
//          own usage records. Cost is at API rates: the provider's own figure when
//          it reports one, else its tokens at API list prices (Codex).
// Layer: Web settings feature
// Exports: UsageAnalyticsPanel

import { formatCompact, formatNumber } from "@synara/profile-ui/formatting";
import { InsightRow, ModelUsageRow, StatTileGrid } from "@synara/profile-ui/sections";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";

import { serverUsageAnalyticsQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SegmentedPicker } from "../SegmentedPicker";
import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import { ChartLegend, DailyBarChart, ProviderLineChart, RhythmChart } from "./UsageAnalyticsCharts";
import {
  buildUsageAnalyticsView,
  localDayKey,
  percentChange,
  PROVIDER_SERIES_COLOR,
  providerLabel,
  type UsageAnalyticsMetric,
  type UsageAnalyticsProvider,
  type UsageAnalyticsProviderTotal,
  type UsageAnalyticsRange,
  type UsageAnalyticsView,
  type UsageAnalyticsWindow,
  usageAnalyticsWindow,
} from "./usageAnalytics.logic";
import { SettingsCard, SettingsListRow } from "./SettingsPanelPrimitives";

const USD = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
});

const RANGES: ReadonlyArray<UsageAnalyticsRange> = ["7d", "30d", "90d", "1y"];

/** The server request for a window: it includes the period before, when fetched. */
function analyticsRequest(window: UsageAnalyticsWindow) {
  return { from: (window.previousFrom ?? window.from).toISOString(), to: window.to.toISOString() };
}

function formatUsd(value: number): string {
  return USD.format(value);
}

/** Axis and tooltip money: whole dollars once amounts are large. */
function formatUsdShort(value: number): string {
  if (value >= 1000) return `$${formatCompact(value)}`;
  if (value >= 10) return `$${Math.round(value)}`;
  return USD.format(value);
}

function formatTokens(value: number): string {
  return formatCompact(value);
}

/** A section heading with a one-line explanation and an optional control on the right. */
function SectionTitle(props: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-ui-lg font-semibold text-foreground">{props.title}</h3>
        {props.detail ? <p className="text-ui text-muted-foreground">{props.detail}</p> : null}
      </div>
      {props.action}
    </div>
  );
}

function ChangeLabel(props: { change: number | null }) {
  if (props.change === null) return null;
  const up = props.change >= 0;
  return (
    <span className={cn("text-ui-sm", up ? "text-info" : "text-muted-foreground")}>
      {up ? "↑" : "↓"} {Math.abs(props.change)}% vs previous period
    </span>
  );
}

function ShareBar(props: { share: number; color: string }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.07]">
      <div
        className="h-1 rounded-full"
        style={{ width: `${Math.max(0, Math.min(100, props.share))}%`, background: props.color }}
      />
    </div>
  );
}

/** The provider's icon; a neutral dot when the provider is unknown. */
function ProviderMark(props: { provider: UsageAnalyticsProvider }) {
  return props.provider === "unknown" ? (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ background: PROVIDER_SERIES_COLOR.unknown }}
    />
  ) : (
    <ProviderIcon provider={props.provider} className="size-3.5 shrink-0" />
  );
}

function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

export function UsageAnalyticsPanel() {
  const [range, setRange] = useState<UsageAnalyticsRange>("30d");
  const [metricChoice, setMetricChoice] = useState<UsageAnalyticsMetric | null>(null);
  const todayKey = localDayKey(new Date());
  // Recomputed once a day so the query keys stay stable within a day.
  const windows = useMemo(() => {
    const noon = new Date(`${todayKey}T12:00:00`);
    return new Map(RANGES.map((option) => [option, usageAnalyticsWindow(option, noon)]));
  }, [todayKey]);
  const window = windows.get(range) ?? usageAnalyticsWindow(range, new Date());
  const query = useQuery(serverUsageAnalyticsQueryOptions(analyticsRequest(window)));
  // While a new period loads, the previous result stays on screen with its own
  // window, so its numbers are never laid over the new period's days.
  const data = query.data;
  const dataWindow = useMemo(() => {
    if (!data) return window;
    return (
      [...windows.values()].find((candidate) => {
        const request = analyticsRequest(candidate);
        return request.from === data.from && request.to === data.to;
      }) ?? window
    );
  }, [data, window, windows]);
  const view = useMemo(
    () => (data ? buildUsageAnalyticsView(data, dataWindow) : null),
    [data, dataWindow],
  );
  const loadingNewPeriod = query.isPlaceholderData;
  const metric: UsageAnalyticsMetric =
    metricChoice ?? (view && view.totals.costUsd > 0 ? "cost" : "tokens");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedPicker<UsageAnalyticsMetric>
            ariaLabel="Metric"
            className="w-44"
            value={metric}
            onValueChange={setMetricChoice}
            options={[
              { value: "cost", label: "Cost" },
              { value: "tokens", label: "Tokens" },
            ]}
          />
          <SegmentedPicker<UsageAnalyticsRange>
            ariaLabel="Period"
            className="w-60"
            value={range}
            onValueChange={setRange}
            options={[
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
              { value: "90d", label: "90d" },
              { value: "1y", label: "1y" },
            ]}
          />
        </div>
        <span className="text-ui-sm text-muted-foreground">Usage in Synara chats</span>
      </div>
      {query.isError && !view ? (
        <SettingsCard>
          <SettingsListRow
            title="Couldn’t load usage"
            actions={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        </SettingsCard>
      ) : !view ? (
        <SettingsCard>
          <SettingsListRow title="Loading usage…" />
        </SettingsCard>
      ) : view.totals.tokens === 0 && view.totals.costUsd === 0 && view.totals.turns === 0 ? (
        <SettingsCard>
          <SettingsListRow
            title="No usage in this period"
            description="Chats you run in Synara show up here as they use tokens."
          />
        </SettingsCard>
      ) : (
        <div
          aria-busy={loadingNewPeriod}
          className={cn("transition-opacity duration-150", loadingNewPeriod && "opacity-50")}
        >
          <UsageAnalyticsBody view={view} metric={metric} rangeDays={dataWindow.days.length} />
        </div>
      )}
    </div>
  );
}

function UsageAnalyticsBody(props: {
  view: UsageAnalyticsView;
  metric: UsageAnalyticsMetric;
  rangeDays: number;
}) {
  const { view, metric } = props;
  const [hidden, setHidden] = useState<ReadonlySet<UsageAnalyticsProvider>>(() => new Set());
  const format = metric === "cost" ? formatUsdShort : formatTokens;
  const valueOf = (amount: { tokens: number; costUsd: number }) =>
    metric === "cost" ? amount.costUsd : amount.tokens;
  const total = valueOf(view.totals);
  const providers = view.providers.filter((provider) => valueOf(provider) > 0);
  const legendProviders = providers.map((provider) => provider.provider);
  const seriesProviders = legendProviders.filter((provider) => !hidden.has(provider));
  const toggleProvider = (provider: UsageAnalyticsProvider) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  const legend = (
    <ChartLegend providers={legendProviders} hidden={hidden} onToggle={toggleProvider} />
  );
  const peakDay = view.days.reduce<(typeof view.days)[number] | null>(
    (best, day) => (!best || valueOf(day) > valueOf(best) ? day : best),
    null,
  );
  const weekdays = view.days.filter((day) => day.date.getDay() !== 0 && day.date.getDay() !== 6);
  const weekdayAverage = weekdays.length
    ? weekdays.reduce((sum, day) => sum + valueOf(day), 0) / weekdays.length
    : 0;
  const providerNames = (source: UsageAnalyticsProviderTotal["costSource"]) =>
    view.providers
      .filter(
        (provider) =>
          provider.costSource === source &&
          (provider.tokens > 0 || provider.costUsd > 0) &&
          provider.provider !== "unknown",
      )
      .map((provider) => providerLabel(provider.provider))
      .join(", ");
  const reportedNames = providerNames("reported");
  const estimatedNames = providerNames("estimated");
  const tokenOnlyNames = providerNames(null);
  const pricesUpdated = view.pricing.fetchedAt
    ? new Date(view.pricing.fetchedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;
  const originTotal = view.origins.user + view.origins.automation + view.origins.agent;
  // Ranked by the metric on screen, so "Cost" shows the most expensive first.
  const byMetric = <T extends { tokens: number; costUsd: number }>(left: T, right: T) =>
    valueOf(right) - valueOf(left) || right.tokens - left.tokens;
  const models = view.models.toSorted(byMetric);
  const projects = view.projects.filter((project) => valueOf(project) > 0).toSorted(byMetric);
  const modelMax = Math.max(1, ...models.map((model) => valueOf(model)));
  const projectTotal = projects.reduce((sum, project) => sum + valueOf(project), 0);

  return (
    // Layout follows the settings column, not the window: the sidebar takes a
    // varying share of the window.
    <div className="@container flex flex-col gap-12">
      <section className="flex flex-col gap-6">
        <div className="flex flex-col gap-8 @3xl:flex-row @3xl:gap-10">
          <div className="flex flex-col gap-1.5 @3xl:w-60 @3xl:shrink-0">
            <span className="text-ui-sm tracking-wide text-muted-foreground uppercase">
              {metric === "cost" ? "API cost" : "Tokens processed"}
            </span>
            <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">
              {metric === "cost" ? formatUsd(total) : formatNumber(total)}
            </span>
            <ChangeLabel
              change={percentChange(total, view.previous ? valueOf(view.previous) : null)}
            />
            <span className="text-ui-sm text-muted-foreground">
              {metric === "cost"
                ? "At API rates, not what plans bill."
                : `${formatTokens(view.totals.cacheReadTokens)} read from cache.`}
            </span>
            <ul className="mt-4 flex flex-col gap-3.5">
              {providers.map((provider) => (
                <ModelUsageRow
                  key={provider.provider}
                  icon={<ProviderMark provider={provider.provider} />}
                  model={providerLabel(provider.provider)}
                  detail={`${formatNumber(provider.turns)} turns`}
                  percent={percentOf(valueOf(provider), total)}
                  stat={`${format(valueOf(provider))} · ${percentOf(valueOf(provider), total)}%`}
                  barColor={PROVIDER_SERIES_COLOR[provider.provider]}
                />
              ))}
            </ul>
          </div>
          <div className="@container/daily flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-ui font-semibold text-foreground">
                {metric === "cost" ? "Daily cost" : "Daily tokens"}
              </span>
              {legend}
            </div>
            <DailyBarChart
              days={view.days}
              providers={seriesProviders}
              metric={metric}
              format={format}
              width={540}
              height={200}
            />
            <dl className="grid gap-x-6 gap-y-1.5 border-t pt-3 @md/daily:grid-cols-3">
              <InsightRow
                label="Peak day"
                value={
                  peakDay && valueOf(peakDay) > 0
                    ? `${peakDay.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${format(valueOf(peakDay))}`
                    : "—"
                }
              />
              <InsightRow label="Weekday avg." value={format(weekdayAverage)} />
              <InsightRow label="Active days" value={`${view.activeDays} of ${props.rangeDays}`} />
            </dl>
          </div>
        </div>
        <StatTileGrid
          fitContainer
          tiles={[
            {
              label: "Processed tokens",
              value: formatTokens(view.totals.tokens),
              detail: `${formatTokens(view.activeDays ? view.totals.tokens / view.activeDays : 0)} per active day`,
            },
            {
              label: "Cache reads",
              value: formatTokens(view.totals.cacheReadTokens),
              detail: `${percentOf(view.totals.cacheReadTokens, view.totals.tokens)}% of tokens`,
            },
            {
              label: "Turns",
              value: formatNumber(view.totals.turns),
              detail: `${formatNumber(view.totals.failedTurns)} ended in error`,
            },
            {
              label: "API cost",
              value: formatUsd(view.totals.costUsd),
              detail:
                view.totals.turns > 0
                  ? `${formatUsd(view.totals.costUsd / view.totals.turns)} per turn`
                  : "No turns",
            },
            {
              label: "Active days",
              value: `${view.activeDays}`,
              detail: `of ${props.rangeDays} in this period`,
            },
          ]}
        />
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle
          title={metric === "cost" ? "Cost by provider" : "Tokens by provider"}
          detail="Each provider on its own line, to compare their shapes."
          action={legend}
        />
        <ProviderLineChart
          days={view.days}
          providers={seriesProviders}
          metric={metric}
          format={format}
        />
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle
          title="Models"
          detail={
            models[0]
              ? metric === "cost"
                ? `${models[0].model} cost the most in this period.`
                : `${models[0].model} did the most work in this period.`
              : "No model activity yet."
          }
        />
        <SettingsCard>
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_5rem] items-center gap-3 px-3 py-2 text-ui-sm text-muted-foreground @md:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_5.5rem] @xl:grid-cols-[minmax(0,1fr)_4rem_5rem_6rem_6rem]">
            <span>Model</span>
            <span className="hidden text-right @md:block">Turns</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Cost</span>
            <span className="hidden @xl:block">Share</span>
          </div>
          {models.slice(0, 12).map((model) => (
            <div
              key={`${model.provider}-${model.model}`}
              className="grid grid-cols-[minmax(0,1fr)_4.5rem_5rem] items-center gap-3 border-t px-3 py-2.5 text-ui @md:grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_5.5rem] @xl:grid-cols-[minmax(0,1fr)_4rem_5rem_6rem_6rem]"
            >
              <span className="flex min-w-0 items-center gap-2 text-foreground">
                <ProviderMark provider={model.provider} />
                <span className="truncate" title={model.model}>
                  {model.model}
                </span>
              </span>
              <span className="hidden text-right tabular-nums text-foreground @md:block">
                {formatNumber(model.turns)}
              </span>
              <span className="text-right tabular-nums text-foreground">
                {formatTokens(model.tokens)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {model.costUsd > 0 ? formatUsd(model.costUsd) : "—"}
              </span>
              <span className="hidden @xl:block">
                <ShareBar
                  share={(valueOf(model) / modelMax) * 100}
                  color={PROVIDER_SERIES_COLOR[model.provider]}
                />
              </span>
            </div>
          ))}
        </SettingsCard>
      </section>

      <section className="grid gap-10 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <SectionTitle title="Projects" detail="Where the work happened." />
          <ul className="flex flex-col gap-3.5">
            {projects.slice(0, 8).map((project) => (
              <ModelUsageRow
                key={project.projectId ?? "chats"}
                icon={null}
                model={project.title}
                {...(project.projectId ? {} : { detail: "outside projects" })}
                percent={percentOf(valueOf(project), projectTotal)}
                stat={`${format(valueOf(project))} · ${percentOf(valueOf(project), projectTotal)}%`}
                barColor="var(--foreground)"
              />
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4">
          <SectionTitle title="Who started the work" detail="Tokens by turn origin." />
          <dl className="flex flex-col gap-2.5">
            {(
              [
                ["user", "You"],
                ["agent", "Agents"],
                ["automation", "Automations"],
              ] as const
            ).map(([origin, label]) => (
              <InsightRow
                key={origin}
                label={label}
                value={`${formatTokens(view.origins[origin])} · ${percentOf(view.origins[origin], originTotal)}%`}
              />
            ))}
          </dl>
        </div>
      </section>

      <section className="grid gap-10 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <SectionTitle title="When you work" detail="Tokens by weekday and hour, in your time." />
          <RhythmChart rhythm={view.rhythm} format={formatTokens} />
        </div>
        <div className="flex flex-col gap-4">
          <SectionTitle title="About these numbers" />
          <ul className="flex list-disc flex-col gap-2 pl-4 text-ui text-muted-foreground marker:text-foreground/30">
            <li>
              Cost is at API rates. A subscription bills its own price, which can be much less.
            </li>
            {reportedNames ? <li>{reportedNames}: cost as the provider reported it.</li> : null}
            {estimatedNames ? (
              <li>
                {estimatedNames}: no cost reported, so its tokens are priced at API list prices
                {pricesUpdated ? ` (LiteLLM, updated ${pricesUpdated})` : ""}.
              </li>
            ) : null}
            {view.pricing.unpricedTokens > 0 ? (
              <li>
                {view.pricing.status === "unavailable"
                  ? "API prices could not be downloaded"
                  : `${view.pricing.unpricedModels.join(", ") || "Some models"} ${view.pricing.unpricedModels.length === 1 ? "has" : "have"} no list price`}
                , so {formatTokens(view.pricing.unpricedTokens)} tokens have no cost.
              </li>
            ) : null}
            {tokenOnlyNames ? <li>{tokenOnlyNames}: tokens only, no cost.</li> : null}
            {view.unavailableProviders.length > 0 ? (
              <li>
                {view.unavailableProviders.map((provider) => providerLabel(provider)).join(", ")}{" "}
                ran turns without reporting token usage.
              </li>
            ) : null}
            <li>Only chats run in Synara are counted, including deleted ones.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
