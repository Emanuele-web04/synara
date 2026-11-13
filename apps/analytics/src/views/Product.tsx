// FILE: Product.tsx
// Purpose: Aggregate permitted product activity and mature cohorts without event-level drilldowns.

import { useMemo, useState } from "react";

import { api, type ProductFilters } from "../api";
import { TurnBreakdownTable } from "../TurnBreakdownTable";
import { PRODUCT_SECTIONS, type ProductSection } from "../filters";
import codexLogo from "../assets/providers/codex.svg?no-inline";
import claudeLogo from "../assets/providers/claude.svg?no-inline";
import {
  chartChrome,
  dayLabel,
  platformLabel,
  deltaDetail,
  EChart,
  EmptyLine,
  ErrorState,
  Loading,
  RelTime,
  Stat,
  TableWrap,
  useApiData,
  useChartTheme,
} from "../components";

const DAY_MS = 86_400_000;
const observationLabel = (value: string) => `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
const today = () => new Date().toISOString().slice(0, 10);
const compact = (value: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const providers: Record<string, { name: string; color: string; icon?: string }> = {
  codex: { name: "Codex", color: "#679bff", icon: codexLogo },
  claude: { name: "Claude", color: "#d98d73", icon: claudeLogo },
  other: { name: "Other", color: "#b394db" },
  unknown: { name: "Unknown", color: "#8b929e" },
};
function ProviderLabel({ provider }: { provider: string }) {
  const meta = providers[provider] ?? providers.unknown!;
  return (
    <span
      className="product-provider"
      style={{ color: `var(--provider-${provider}, ${meta.color})` }}
    >
      <span
        className={meta.icon ? "product-provider-logo" : "product-provider-dot"}
        aria-hidden="true"
        style={
          meta.icon
            ? { maskImage: `url(${meta.icon})`, WebkitMaskImage: `url(${meta.icon})` }
            : undefined
        }
      />
      <span>{meta.name}</span>
    </span>
  );
}
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
const surfaceLabel = (surface: string) =>
  surface === "ios" ? "iPhone" : surface === "ipados" ? "iPad" : "Desktop";
const reasonLabels: Record<string, string> = {
  unreachable: "Computer unreachable",
  not_accepting: "Not accepting remote connections",
  account_unavailable: "Account service unavailable",
  host_unlinked: "Computer no longer linked",
  pairing_required: "Pairing required",
  incompatible: "Version incompatible",
  timeout: "Timed out",
  invalid_code: "Invalid pairing code",
  rejected: "Rejected",
  other: "Other",
};
const turnFailureLabels: Record<string, string> = {
  edge_blocked: "Network edge blocked (Cloudflare)",
  auth: "Not signed in",
  account: "Account issue",
  billing: "Billing",
  rate_limit: "Rate limited",
  usage_limit: "Usage limit",
  overloaded: "Provider overloaded",
  server_error: "Provider server error",
  network: "Connection lost",
  invalid_request: "Request rejected",
  model_unavailable: "Model unavailable",
  context_limit: "Context full",
  output_limit: "Output limit",
  other: "Other",
};
const eventLabels: Record<string, string> = {
  "chat.request": "Chat request",
  "connection.connect": "Connect",
  "connection.reconnect": "Reconnect",
  "connection.pair": "Pairing",
};

const sectionCopy = {
  overview: {
    title: "Overview",
    description: "A snapshot of activity, adoption and the features people use.",
  },
  providers: {
    title: "Providers",
    description: "Compare provider activity, daily trends and share of observed turns.",
  },
  tokens: {
    title: "Tokens",
    description: "Explore observed input, output and cached tokens, with sample coverage.",
  },
  reliability: {
    title: "Reliability",
    description: "Understand turn outcomes, connection results and observed durations.",
  },
};

export function Product({
  section,
  onAuthError,
}: {
  section: ProductSection;
  onAuthError: () => void;
}) {
  const [filters, setFilters] = useState<ProductFilters>(() => ({
    from: daysAgo(7),
    to: daysAgo(1),
    channel: "",
    surface: "",
  }));
  const theme = useChartTheme();
  const key = JSON.stringify(filters);
  const { data, error, busy, retry } = useApiData(() => api.product(filters), [key], onAuthError);
  const chartOptions = useMemo(() => {
    if (!data) return null;
    const chrome = chartChrome(theme);
    const daily = new Map(
      data.observedDesktopTurns.daily.map((row) => [`${row.provider}:${row.day}`, row.turns]),
    );
    const visibleProviders = [
      "codex",
      "claude",
      ...data.observedDesktopTurns.providers
        .map((row) => row.provider)
        .filter((provider) => provider !== "codex" && provider !== "claude"),
    ];
    return {
      ...chrome,
      grid: { ...chrome.grid, top: 20, right: 90, bottom: 12 },
      tooltip: {
        ...chrome.tooltip,
        valueFormatter: (value: unknown) => `${Number(value).toLocaleString()} turns`,
      },
      xAxis: {
        ...chrome.xAxis,
        boundaryGap: false,
        data: data.daily.map((row) => dayLabel(row.day)),
      },
      yAxis: {
        ...chrome.yAxis,
        min: 0,
        axisLabel: { ...chrome.yAxis.axisLabel, formatter: compact },
      },
      series: visibleProviders.map((provider) => {
        const meta = providers[provider] ?? providers.unknown!;
        const color =
          theme.mode === "light"
            ? ((
                {
                  codex: "#2563eb",
                  claude: "#aa5336",
                  other: "#7652a3",
                  unknown: "#646b76",
                } as Record<string, string>
              )[provider] ?? meta.color)
            : meta.color;
        return {
          name: meta.name,
          type: "line" as const,
          data: data.daily.map((row) => daily.get(`${provider}:${row.day}`) ?? 0),
          symbol: "circle",
          symbolSize: 6,
          showSymbol: true,
          smooth: false,
          lineStyle: { color, width: 2.5 },
          itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
          areaStyle: { color, opacity: 0.06 },
          endLabel: {
            show: true,
            formatter: (point: { value?: unknown }) =>
              `${meta.name}  ${compact(Number(point.value))}`,
            color,
            fontWeight: 600,
          },
          labelLayout: { moveOverlap: "shiftY" as const },
          emphasis: { focus: "series" as const },
        };
      }),
    };
  }, [data, theme]);
  const totals = data?.observedDesktopTurns;
  const codex = totals?.providers.find((row) => row.provider === "codex")?.turns ?? 0;
  const claude = totals?.providers.find((row) => row.provider === "claude")?.turns ?? 0;
  const rangeDays = Math.round((Date.parse(filters.to) - Date.parse(filters.from)) / DAY_MS) + 1;

  return (
    <div>
      <h1 className="heading-32">Product analytics</h1>
      <nav className="main-nav product-section-nav" aria-label="Product analytics sections">
        {PRODUCT_SECTIONS.map((item) => (
          <a
            key={item}
            href={`#/product/${item}`}
            className={section === item ? "active" : undefined}
            aria-current={section === item ? "page" : undefined}
          >
            {sectionCopy[item].title}
          </a>
        ))}
      </nav>
      <div className="filter-row" aria-label="Product event filters">
        <div className="product-presets" aria-label="Date presets">
          {[7, 14, 30].map((days) => (
            <button
              key={days}
              type="button"
              className="product-preset"
              aria-pressed={filters.from === daysAgo(days) && filters.to === daysAgo(1)}
              onClick={() =>
                setFilters((current) => ({ ...current, from: daysAgo(days), to: daysAgo(1) }))
              }
            >
              {days} days
            </button>
          ))}
        </div>
        <label className="label-13 secondary">
          From{" "}
          <input
            className="input"
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(e) => setFilters((current) => ({ ...current, from: e.target.value }))}
          />
        </label>
        <label className="label-13 secondary">
          To{" "}
          <input
            className="input"
            type="date"
            value={filters.to}
            min={filters.from}
            max={today()}
            onChange={(e) => setFilters((current) => ({ ...current, to: e.target.value }))}
          />
        </label>
        <span className="select-wrap">
          <select
            className="select"
            aria-label="Channel"
            value={filters.channel}
            onChange={(e) =>
              setFilters((current) => ({
                ...current,
                channel: e.target.value as ProductFilters["channel"],
              }))
            }
          >
            <option value="">All channels</option>
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
            <option value="remote">Remote</option>
          </select>
        </span>
        <span className="select-wrap">
          <select
            className="select"
            aria-label="Surface"
            value={filters.surface}
            onChange={(e) =>
              setFilters((current) => ({
                ...current,
                surface: e.target.value as ProductFilters["surface"],
              }))
            }
          >
            <option value="">All surfaces</option>
            <option value="desktop">Desktop</option>
            <option value="ios">iOS</option>
            <option value="ipados">iPadOS</option>
          </select>
        </span>
      </div>

      {error || !data ? (
        error ? (
          <ErrorState error={error} onRetry={retry} />
        ) : (
          <Loading />
        )
      ) : (
        <div aria-busy={busy} className={busy ? "stale" : undefined}>
          <div className="product-title-row">
            <h2 className="heading-20">{sectionCopy[section].title}</h2>
            <span className="product-range">
              {dayLabel(data.from)} – {dayLabel(data.to)} · UTC
            </span>
          </div>
          <p className="chart-caption">{sectionCopy[section].description}</p>
          {section === "overview" && (
            <>
              {data.activeUsers && (
                <section className="section" aria-labelledby="product-active">
                  <h3 id="product-active" className="heading-20 section-head">
                    Active installations
                  </h3>
                  <p className="chart-caption">
                    Installations seen in the last 24 hours, 7 days and 30 days, ending now; the
                    date range does not apply. Engaged installations attempted at least one chat
                    request, including failed requests. This does not measure successful uses.
                  </p>
                  <div className="stat-strip stat-strip--four">
                    <Stat
                      label="Daily active installations"
                      value={compact(data.activeUsers.day)}
                      detail="Last 24 hours"
                    />
                    <Stat
                      label="Weekly active installations"
                      value={compact(data.activeUsers.week)}
                      detail="Last 7 days"
                    />
                    <Stat
                      label="Monthly active installations"
                      value={compact(data.activeUsers.month)}
                      detail="Last 30 days"
                    />
                    <Stat
                      label="Engaged installations this week"
                      value={compact(data.activeUsers.engagedWeek)}
                      detail={`${compact(data.activeUsers.engagedDay)} today · ${compact(
                        data.activeUsers.engagedMonth,
                      )} this month`}
                    />
                  </div>
                </section>
              )}
              {data.cohorts && (
                <section className="section" aria-labelledby="product-cohorts">
                  <h3 id="product-cohorts" className="heading-20 section-head">
                    Reporting installation cohorts
                  </h3>
                  <p className="chart-caption">
                    Last 90 complete UTC cohort days, independent of the date range above; channel
                    and surface filters apply. New reporting installations include measurement
                    adoption, resets and reinstalls. They are not downloads or people. Return
                    windows are days 7–13 and 30–36 after entry. Rates include only cohorts past the
                    full window plus seven days for delayed uploads. Non-return means no observed
                    report in that window, not an uninstall or subscription cancellation. Opt-outs
                    and offline devices can look inactive.
                  </p>
                  <div className="stat-strip">
                    <Stat
                      label="New reporting installations"
                      value={compact(data.cohorts.newReportingInstallations)}
                      detail="First cohort report · last 90 complete UTC days"
                    />
                    <Stat
                      label="Week 1 return"
                      value={
                        data.cohorts.week1.ratePct === null
                          ? "Not mature"
                          : `${data.cohorts.week1.ratePct}%`
                      }
                      detail={`${compact(data.cohorts.week1.returned)} returns / ${compact(data.cohorts.week1.entries)} mature entries`}
                    />
                    <Stat
                      label="Month 1 return"
                      value={
                        data.cohorts.month1.ratePct === null
                          ? "Not mature"
                          : `${data.cohorts.month1.ratePct}%`
                      }
                      detail={`${compact(data.cohorts.month1.returned)} returns / ${compact(data.cohorts.month1.entries)} mature entries`}
                    />
                  </div>
                  {data.cohorts.rows.length === 0 ? (
                    <EmptyLine text="No reporting cohorts yet. Existing activity is not backfilled into retention." />
                  ) : (
                    <TableWrap>
                      <table className="data">
                        <thead>
                          <tr>
                            <th scope="col">Cohort entry · UTC</th>
                            <th scope="col">New reporting installations</th>
                            <th scope="col">Week 1 returns</th>
                            <th scope="col">Month 1 returns</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.cohorts.rows.map((row) => (
                            <tr key={row.day}>
                              <td>{dayLabel(row.day)}</td>
                              <td>{row.entries.toLocaleString()}</td>
                              <td>
                                {row.week1Mature
                                  ? `${row.week1Returns.toLocaleString()} / ${row.entries.toLocaleString()}`
                                  : "Pending maturity"}
                              </td>
                              <td>
                                {row.month1Mature
                                  ? `${row.month1Returns.toLocaleString()} / ${row.entries.toLocaleString()}`
                                  : "Pending maturity"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  )}
                </section>
              )}
              {data.installerDownloads && (
                <section className="section" aria-labelledby="product-downloads">
                  <h3 id="product-downloads" className="heading-20 section-head">
                    Installer downloads
                  </h3>
                  {data.installerDownloads.status === "unsupported_store" ? (
                    <EmptyLine text="App Store download counts are unavailable here. They require the app owner's store analytics; app opens do not measure downloads." />
                  ) : (
                    <>
                      <p className="chart-caption">
                        Public GitHub counters for desktop .dmg, .exe and .AppImage assets,
                        including repeat downloads, updaters and bots. These are not unique people
                        or installations. App Store downloads are not included.
                      </p>
                      <div className="stat-strip">
                        <Stat
                          label="Latest GitHub installer counter"
                          value={data.installerDownloads.total?.toLocaleString() ?? "—"}
                          detail={
                            data.installerDownloads.observedAt
                              ? `Observed ${observationLabel(data.installerDownloads.observedAt)}; date range does not apply`
                              : "Awaiting the first successful source snapshot"
                          }
                        />
                      </div>
                      <p className="chart-caption">
                        History shows increases observed between successful source snapshots, with
                        the ending snapshot in this date range. These are not exact daily downloads.
                        The first snapshot is a baseline. Deleted, reset, reclassified or newly
                        discovered older assets leave coverage unknown; the counter can fall when
                        assets disappear. History is normally kept for 90 days; source outages can
                        delay cleanup.
                      </p>
                      {data.installerDownloads.history.length === 0 ? (
                        <EmptyLine text="No successful source snapshots end in this range." />
                      ) : (
                        <TableWrap>
                          <table className="data">
                            <thead>
                              <tr>
                                <th scope="col">Previous observation</th>
                                <th scope="col">Observation</th>
                                <th scope="col" className="num">
                                  Source counter
                                </th>
                                <th scope="col" className="num">
                                  Observed increase
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.installerDownloads.history.map((row) => (
                                <tr key={row.to}>
                                  <td>{row.from ? observationLabel(row.from) : "Baseline"}</td>
                                  <td>{observationLabel(row.to)}</td>
                                  <td className="num">{row.total.toLocaleString()}</td>
                                  <td className="num">
                                    {row.downloads === null
                                      ? row.from
                                        ? "Unknown coverage"
                                        : "Baseline"
                                      : row.downloads.toLocaleString()}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </TableWrap>
                      )}
                    </>
                  )}
                </section>
              )}
              <div className="stat-strip">
                <Stat label="Product events" value={compact(data.events)} />
                <Stat
                  label="Active installations"
                  value={compact(data.activeInstallations)}
                  detail="Installations, not individual people"
                />
                <Stat
                  label="Accepted requests"
                  value={compact(
                    data.outcomes.find(
                      (row) => row.event === "chat.request" && row.outcome === "succeeded",
                    )?.events ?? 0,
                  )}
                  detail="Submission acknowledged; not completed turns"
                />
              </div>

              <section className="section" aria-labelledby="product-activity">
                <h3 id="product-activity" className="heading-20 section-head">
                  Daily product activity
                </h3>
                {data.events === 0 ? (
                  <EmptyLine text="No product events in this range." />
                ) : (
                  <EChart
                    height={250}
                    ariaLabel="Daily opt-in product events"
                    option={{
                      ...chartChrome(theme),
                      xAxis: {
                        ...chartChrome(theme).xAxis,
                        boundaryGap: false,
                        data: data.daily.map((row) => dayLabel(row.day)),
                      },
                      yAxis: { ...chartChrome(theme).yAxis, min: 0 },
                      series: [
                        {
                          name: "Events",
                          type: "line",
                          data: data.daily.map((row) => row.events),
                          showSymbol: false,
                          lineStyle: { color: theme.gray1000, width: 2 },
                          itemStyle: { color: theme.gray1000 },
                          areaStyle: { opacity: 0.05 },
                        },
                      ],
                    }}
                  />
                )}
              </section>
              {data.platforms && (
                <section className="section" aria-labelledby="product-platforms">
                  <h2 id="product-platforms" className="heading-20 section-head">
                    Platforms
                  </h2>
                  {data.platforms.length === 0 ? (
                    <EmptyLine text="No product events in this range." />
                  ) : (
                    <TableWrap>
                      <table className="data">
                        <thead>
                          <tr>
                            <th scope="col">Device</th>
                            <th scope="col" className="num">
                              Installations
                            </th>
                            <th scope="col" className="num">
                              Events
                            </th>
                            <th scope="col" className="num">
                              Failed requests
                            </th>
                            <th scope="col" className="num">
                              Failed connections
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.platforms.map((row) => (
                            <tr key={`${row.surface}:${row.platform}`}>
                              <td>
                                {row.surface === "desktop"
                                  ? platformLabel(row.platform)
                                  : surfaceLabel(row.surface)}
                              </td>
                              <td className="num">{row.installations.toLocaleString()}</td>
                              <td className="num">{row.events.toLocaleString()}</td>
                              <td className="num">{row.failedRequests.toLocaleString()}</td>
                              <td className="num">{row.failedConnections.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  )}
                </section>
              )}
              {data.commands && (
                <section className="section" aria-labelledby="product-commands">
                  <h2 id="product-commands" className="heading-20 section-head">
                    Commands
                  </h2>
                  <p className="chart-caption">
                    Built-in keyboard shortcuts and slash commands. Names people defined themselves
                    are counted as custom.
                  </p>
                  {data.commands.length === 0 ? (
                    <EmptyLine text="No commands in this range." />
                  ) : (
                    <TableWrap>
                      <table className="data">
                        <thead>
                          <tr>
                            <th scope="col">Command</th>
                            <th scope="col">Used with</th>
                            <th scope="col" className="num">
                              Uses
                            </th>
                            <th scope="col" className="num">
                              Installations
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.commands.map((row) => {
                            const [kind, name] = row.command.split(":");
                            return (
                              <tr key={row.command}>
                                <td>{kind === "slash" ? `/${name}` : name}</td>
                                <td>{kind === "slash" ? "Slash command" : "Shortcut"}</td>
                                <td className="num">{row.events.toLocaleString()}</td>
                                <td className="num">{row.installations.toLocaleString()}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </TableWrap>
                  )}
                </section>
              )}
              <section className="section" aria-labelledby="product-features">
                <h2 id="product-features" className="heading-20 section-head">
                  Features
                </h2>
                {data.features.length === 0 ? (
                  <EmptyLine text="No feature events in this range." />
                ) : (
                  <TableWrap>
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Feature</th>
                          <th scope="col" className="num">
                            Events
                          </th>
                          <th scope="col" className="num">
                            Installations
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.features.map((row) => (
                          <tr key={row.feature}>
                            <td>{row.feature}</td>
                            <td className="num">{row.events}</td>
                            <td className="num">{row.installations}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </section>
            </>
          )}
          {section === "providers" && (
            <>
              {data.hostExecutions && (
                <section className="section" aria-labelledby="host-executions">
                  <h2 id="host-executions" className="heading-20 section-head">
                    Host executions by model and effort
                  </h2>
                  <p className="chart-caption">
                    Product-consented snapshots of completed UTC days from execution hosts,
                    including connected-phone, automation and agent work. The surface filter does
                    not identify where work began. These are separate from renderer observations
                    below and billing totals. Offline gaps, late projection updates and capped
                    windows can omit work.
                  </p>
                  <div className="stat-strip stat-strip--four">
                    <Stat
                      label="Daily host reports"
                      value={compact(data.hostExecutions.coverage.reportWindows)}
                      detail={`${compact(data.hostExecutions.coverage.partialWindows)} start after a sharing-resume cutoff`}
                    />
                    <Stat
                      label="Captured eligible turns"
                      value={compact(data.hostExecutions.coverage.includedTurns)}
                      detail={`${compact(data.hostExecutions.coverage.eligibleTurns)} present at capture · ${compact(data.hostExecutions.coverage.eligibleTurns - data.hostExecutions.coverage.includedTurns)} omitted by limits`}
                    />
                    <Stat
                      label="Missing completion times"
                      value={compact(data.hostExecutions.coverage.missingCompletionTimes)}
                      detail="Excluded terminal records, grouped by request day"
                    />
                    <Stat
                      label="Limited token measurements"
                      value={compact(data.hostExecutions.coverage.tokenTruncatedTurns)}
                      detail={`${compact(data.hostExecutions.coverage.cappedMeasurements)} field aggregates exceeded limits`}
                    />
                  </div>
                  <TurnBreakdownTable rows={data.hostExecutions.rows} />
                </section>
              )}
              <section className="product-hero" aria-label="Renderer observation comparison">
                <div className="product-headlines">
                  {["claude", "codex"].map((provider) => {
                    const count =
                      data.observedDesktopTurns.providers.find((row) => row.provider === provider)
                        ?.turns ?? 0;
                    const previous = data.observedDesktopTurns.previous;
                    const baseline =
                      previous?.providers.find((row) => row.provider === provider)?.turns ?? 0;
                    const delta = deltaDetail(count, previous ? baseline : null, {
                      range: `${rangeDays} days`,
                    });
                    return (
                      <div className="product-headline" key={provider}>
                        <ProviderLabel provider={provider} />
                        <p className="product-big-number numeric" title={count.toLocaleString()}>
                          {compact(count)}
                        </p>
                        <p className="product-metric-label">observed turns</p>
                        <p className="product-comparison">
                          {delta
                            ? `${delta.delta} ${delta.suffix}`
                            : "Comparison unavailable for this range"}
                        </p>
                      </div>
                    );
                  })}
                  <div className="product-headline product-ratio">
                    <span className="product-metric-label">Provider ratio</span>
                    <p className="product-big-number numeric">
                      {codex > 0
                        ? `${(claude / codex).toLocaleString("en", { maximumFractionDigits: 2 })}×`
                        : "—"}
                    </p>
                    <p className="product-metric-label">Claude turns per Codex turn</p>
                    <p className="product-comparison">
                      {codex > 0 ? "Across the selected period" : "Needs observed Codex turns"}
                    </p>
                  </div>
                </div>
                <div className="product-chart-title">
                  <h2 className="heading-20">Turns over time</h2>
                  <span className="product-metric-label">
                    {filters.to >= today() ? "Today is incomplete" : "Complete UTC days"}
                  </span>
                </div>
                {data.observedDesktopTurns.total === 0 ? (
                  <div className="product-empty">
                    <EmptyLine text="No observed turns yet" />
                    <p className="chart-caption">
                      Use an updated desktop app with Product Analytics enabled, or choose another
                      date range.
                    </p>
                  </div>
                ) : (
                  <EChart
                    option={chartOptions!}
                    height={320}
                    ariaLabel="Daily observed turns by provider"
                  />
                )}
                <div className="product-share" aria-label="Share of observed turns">
                  {data.observedDesktopTurns.providers.map((row) => (
                    <div key={row.provider} className="product-share-row">
                      <ProviderLabel provider={row.provider} />
                      <div className="product-share-track" aria-hidden="true">
                        <span
                          style={{
                            width: `${(row.turns / data.observedDesktopTurns.total) * 100}%`,
                            background: (providers[row.provider] ?? providers.unknown!).color,
                          }}
                        />
                      </div>
                      <span className="numeric">
                        {((row.turns / data.observedDesktopTurns.total) * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
                <p className="product-footnote">
                  Opt-in desktop observations · One turn is one provider execution · Not unique
                  across devices
                </p>
              </section>
            </>
          )}
          {section === "tokens" && (
            <>
              <section className="section" aria-labelledby="product-token-usage">
                <h2 id="product-token-usage" className="heading-20 section-head">
                  Observed desktop completion tokens
                </h2>
                <p className="chart-caption">
                  Only desktop turn.completed events with token fields contribute. Each total shows
                  its own sample count; no samples means the value is unknown. These are not
                  account-wide usage or billing totals.
                </p>
                <TableWrap>
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Measure</th>
                        <th scope="col" className="num">
                          Observed total
                        </th>
                        <th scope="col" className="num">
                          Samples
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ["Input tokens", data.observedDesktopCompletions.inputTokens],
                          ["Output tokens", data.observedDesktopCompletions.outputTokens],
                          [
                            "Cached input tokens",
                            data.observedDesktopCompletions.cachedInputTokens,
                          ],
                        ] as const
                      ).map(([label, measure]) => (
                        <tr key={label}>
                          <td>{label}</td>
                          <td className="num">
                            {measure.total === null ? "Unknown" : measure.total.toLocaleString()}
                          </td>
                          <td className="num">{measure.samples.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </section>
              <section className="section" aria-labelledby="product-provider-samples">
                <h3 id="product-provider-samples" className="heading-20 section-head">
                  By provider
                </h3>
                {data.observedDesktopTurns.providers.length === 0 ? (
                  <EmptyLine text="No observed desktop turns in this range." />
                ) : (
                  <TableWrap>
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Provider</th>
                          <th scope="col" className="num">
                            Finished
                          </th>
                          <th scope="col" className="num">
                            Succeeded
                          </th>
                          <th scope="col" className="num">
                            Failed
                          </th>
                          <th scope="col" className="num">
                            Cancelled
                          </th>
                          <th scope="col" className="num">
                            Input tokens
                          </th>
                          <th scope="col" className="num">
                            Output tokens
                          </th>
                          <th scope="col" className="num">
                            Cached input
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.observedDesktopTurns.providers.map((row) => (
                          <tr key={row.provider}>
                            <td>
                              <ProviderLabel provider={row.provider} />
                            </td>
                            <td className="num">{row.turns.toLocaleString()}</td>
                            <td className="num">{row.succeeded.toLocaleString()}</td>
                            <td className="num">{row.failed.toLocaleString()}</td>
                            <td className="num">{row.cancelled.toLocaleString()}</td>
                            {(
                              [
                                [row.inputTokens, row.inputSamples],
                                [row.outputTokens, row.outputSamples],
                                [row.cachedInputTokens, row.cachedInputSamples],
                              ] as const
                            ).map(([value, samples], index) => (
                              <td className="num" key={index}>
                                {value === null ? "Unknown" : value.toLocaleString()}
                                <div className="chart-caption">
                                  {samples.toLocaleString()} {samples === 1 ? "sample" : "samples"}
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </section>
            </>
          )}
          {section === "reliability" && (
            <>
              <section className="section" aria-labelledby="product-turns">
                <h2 id="product-turns" className="heading-20 section-head">
                  How turns finished
                </h2>
                <p className="chart-caption">
                  Terminal desktop reports only. Accepted requests confirm submission, not
                  completion; they can come from any client surface and are not a success-rate
                  denominator.
                </p>
                <div className="stat-strip stat-strip--four">
                  <Stat label="Finished" value={data.observedDesktopTurns.total.toLocaleString()} />
                  <Stat
                    label="Succeeded"
                    value={data.observedDesktopTurns.succeeded.toLocaleString()}
                  />
                  <Stat label="Failed" value={data.observedDesktopTurns.failed.toLocaleString()} />
                  <Stat
                    label="Cancelled"
                    value={data.observedDesktopTurns.cancelled.toLocaleString()}
                  />
                </div>
              </section>
              {data.failureReasons && (
                <section className="section" aria-labelledby="product-reasons">
                  <h2 id="product-reasons" className="heading-20 section-head">
                    Why things failed
                  </h2>
                  {data.failureReasons.length === 0 ? (
                    <EmptyLine text="No failures with a known cause in this range." />
                  ) : (
                    <TableWrap>
                      <table className="data">
                        <thead>
                          <tr>
                            <th scope="col">Action</th>
                            <th scope="col">Cause</th>
                            <th scope="col">Device</th>
                            <th scope="col" className="num">
                              Failures
                            </th>
                            <th scope="col" className="num">
                              Installations
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.failureReasons.map((row) => (
                            <tr key={`${row.event}:${row.reason}:${row.surface}`}>
                              <td>{eventLabels[row.event] ?? row.event}</td>
                              <td>{reasonLabels[row.reason] ?? row.reason}</td>
                              <td>{surfaceLabel(row.surface)}</td>
                              <td className="num">{row.events.toLocaleString()}</td>
                              <td className="num">{row.installations.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  )}
                </section>
              )}
              {data.turnFailures && (
                <section className="section" aria-labelledby="product-turn-failures">
                  <h2 id="product-turn-failures" className="heading-20 section-head">
                    Why turns failed
                  </h2>
                  {data.turnFailures.length === 0 ? (
                    <EmptyLine text="No failed or error-interrupted turns in this range." />
                  ) : (
                    <TableWrap>
                      <table className="data">
                        <thead>
                          <tr>
                            <th scope="col">Provider</th>
                            <th scope="col">Cause</th>
                            <th scope="col" className="num">
                              HTTP
                            </th>
                            <th scope="col">Ended as</th>
                            <th scope="col">Channel</th>
                            <th scope="col" className="num">
                              Turns
                            </th>
                            <th scope="col" className="num">
                              Installations
                            </th>
                            <th scope="col">Last seen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.turnFailures.map((row) => (
                            <tr
                              key={`${row.provider}:${row.failure}:${row.httpStatus}:${row.outcome}:${row.channel}`}
                            >
                              <td>
                                <ProviderLabel provider={row.provider ?? "unknown"} />
                              </td>
                              <td>{turnFailureLabels[row.failure] ?? row.failure}</td>
                              <td className="num">{row.httpStatus ?? "—"}</td>
                              <td>{row.outcome === "cancelled" ? "Interrupted" : "Failed"}</td>
                              <td>{row.channel}</td>
                              <td className="num">{row.turns.toLocaleString()}</td>
                              <td className="num">{row.installations.toLocaleString()}</td>
                              <td>
                                <RelTime ts={row.lastSeen} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  )}
                </section>
              )}
              <section className="section" aria-labelledby="product-outcomes">
                <h2 id="product-outcomes" className="heading-20 section-head">
                  Outcomes
                </h2>
                {data.outcomes.length === 0 ? (
                  <EmptyLine text="No outcome events in this range." />
                ) : (
                  <TableWrap>
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Event</th>
                          <th scope="col">Outcome</th>
                          <th scope="col" className="num">
                            Events
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.outcomes.map((row) => (
                          <tr key={`${row.event}:${row.outcome}`}>
                            <td>{row.event}</td>
                            <td>{row.outcome}</td>
                            <td className="num">{row.events}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </section>
              <section className="section" aria-labelledby="product-latency">
                <h2 id="product-latency" className="heading-20 section-head">
                  Mean duration
                </h2>
                {data.latency.length === 0 ? (
                  <EmptyLine text="No duration samples in this range." />
                ) : (
                  <TableWrap>
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Event</th>
                          <th scope="col" className="num">
                            Mean
                          </th>
                          <th scope="col" className="num">
                            Samples
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.latency.map((row) => (
                          <tr key={row.event}>
                            <td>{row.event}</td>
                            <td className="num">{row.meanDurationMs.toLocaleString()} ms</td>
                            <td className="num">{row.samples}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
