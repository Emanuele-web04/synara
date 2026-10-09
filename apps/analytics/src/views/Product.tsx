// FILE: Product.tsx
// Purpose: Aggregate the explicitly enabled product event stream without exposing event-level rows.

import { useMemo, useState } from "react";

import { api, type ProductFilters } from "../api";
import { PRODUCT_SECTIONS, type ProductSection } from "../filters";
import codexLogo from "../assets/providers/codex.svg?no-inline";
import claudeLogo from "../assets/providers/claude.svg?no-inline";
import {
  chartChrome,
  dayLabel,
  deltaDetail,
  EChart,
  EmptyLine,
  ErrorState,
  Loading,
  Stat,
  TableWrap,
  useApiData,
  useChartTheme,
} from "../components";

const DAY_MS = 86_400_000;
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
              <section className="product-hero" aria-label="Provider comparison">
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
