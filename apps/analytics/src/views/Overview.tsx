// FILE: src/views/Overview.tsx
// Purpose: "Is Beta healthy right now, and what should we fix first?" —
// a headline answer, a bare stat strip, the top issues table, the daily
// problems chart, the latest release line, and the recent activity list.

import { useMemo } from "react";
import type { EChartsOption } from "echarts";

import { pickFilters, type ActivityEvent, type Filters, type OverviewData } from "../api";
import { api } from "../api";
import { navigate } from "../filters";
import {
  activityKindWord,
  chartChrome,
  dayLabel,
  deltaDetail,
  DeltaText,
  EChart,
  EmptyLine,
  ErrorState,
  FilterBar,
  filtersAreDefault,
  HealthWord,
  IssueTable,
  Loading,
  platformLabel,
  plural,
  rangeLabel,
  rangeSpansYears,
  relativeTime,
  Stat,
  useApiData,
  useChartTheme,
} from "../components";

function headline(data: OverviewData, filters: Filters): string {
  const range = rangeLabel(filters);
  if (data.crashFreePct === null) return `No Beta installs reported in the ${range}.`;
  return `${data.crashFreePct}% of installs were crash-free over the ${range}.`;
}

/** "Most problems on Sep 22 came from errors." Data-derived; null when flat. */
function problemsCaption(ts: OverviewData["timeseries"]): string | null {
  const totals = ts.map((d) => ({
    day: d.day,
    n: d.errors + d.crashes + d.updateFailures,
    dominant:
      d.errors >= d.crashes && d.errors >= d.updateFailures
        ? "errors"
        : d.crashes >= d.updateFailures
          ? "crashes"
          : "update checks",
  }));
  const peak = totals.reduce((a, b) => (b.n > a.n ? b : a), { day: "", n: 0, dominant: "" });
  if (peak.n === 0) return null;
  const label = new Date(`${peak.day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Most problems on ${label} came from ${peak.dominant}.`;
}

const FIELDS = ["days", "version", "platform", "kind", "search"] as const;
const REQ_FIELDS = ["version", "platform", "kind", "q"] as const;

export function Overview({
  filters,
  onFilterChange,
  onAuthError,
}: {
  filters: Filters;
  onFilterChange: (patch: Partial<Filters>) => void;
  onAuthError: () => void;
}) {
  const t = useChartTheme();
  // Only the params this view's filter bar exposes go on the request.
  const reqFilters = useMemo(() => pickFilters(filters, REQ_FIELDS), [filters]);
  const { data, error, busy, retry } = useApiData(
    () => api.overview(reqFilters),
    [JSON.stringify(reqFilters)],
    onAuthError,
  );
  const {
    data: activity,
    error: activityError,
    retry: retryActivity,
  } = useApiData(() => api.activity(reqFilters), [JSON.stringify(reqFilters)], onAuthError);

  const chartOptions = useMemo(() => {
    if (!data) return null;
    const chrome = chartChrome(t);
    const showYear = rangeSpansYears(data.timeseries);
    return {
      ...chrome,
      xAxis: {
        ...chrome.xAxis,
        data: data.timeseries.map((d) => dayLabel(d.day, showYear)),
        axisLabel: {
          ...chrome.xAxis.axisLabel,
          interval: Math.max(0, Math.floor(data.timeseries.length / 12)),
        },
      },
      series: [
        {
          name: "Crashes",
          type: "bar" as const,
          stack: "problems",
          data: data.timeseries.map((d) => d.crashes),
          itemStyle: { color: t.gray1000 },
          barMaxWidth: 18,
        },
        {
          name: "Errors",
          type: "bar" as const,
          stack: "problems",
          data: data.timeseries.map((d) => d.errors),
          itemStyle: { color: t.gray600 },
          barMaxWidth: 18,
        },
        {
          name: "Update failures",
          type: "bar" as const,
          stack: "problems",
          data: data.timeseries.map((d) => d.updateFailures),
          itemStyle: { color: t.gray500 },
          barMaxWidth: 18,
        },
      ],
    };
  }, [data, t]);

  const sentence =
    data && !filtersAreDefault(reqFilters)
      ? `${plural(data.activeInstalls, "install")} in scope`
      : undefined;

  return (
    <div>
      <FilterBar
        filters={filters}
        onChange={onFilterChange}
        onAuthError={onAuthError}
        fields={[...FIELDS]}
        sentence={sentence}
      />
      {!data ? (
        error ? (
          <ErrorState error={error} onRetry={retry} />
        ) : (
          <Loading />
        )
      ) : (
        // Stale data stays on screen dimmed while the refetch runs.
        <div aria-busy={busy} className={busy ? "stale" : undefined}>
          {error && <ErrorState error={error} onRetry={retry} />}
          <OverviewBody
            data={data}
            activity={activity}
            activityError={activityError}
            retryActivity={retryActivity}
            filters={filters}
            t={t}
            chartOptions={chartOptions!}
          />
        </div>
      )}
    </div>
  );
}

function OverviewBody({
  data,
  activity,
  activityError,
  retryActivity,
  filters,
  t,
  chartOptions,
}: {
  data: OverviewData;
  activity: { activity: ActivityEvent[] } | null;
  activityError: string | null;
  retryActivity: () => void;
  filters: Filters;
  t: ReturnType<typeof useChartTheme>;
  chartOptions: EChartsOption;
}) {
  const totals = {
    crashes: data.timeseries.reduce((n, d) => n + d.crashes, 0),
    errors: data.timeseries.reduce((n, d) => n + d.errors, 0),
    updateFailures: data.timeseries.reduce((n, d) => n + d.updateFailures, 0),
  };
  const caption = problemsCaption(data.timeseries);

  const prevRange = filters.days === 1 ? "24 hours" : `${filters.days} days`;
  const installsDelta = deltaDetail(data.activeInstalls, data.previous.activeInstalls, {
    range: prevRange,
  });
  const installsDetail = (
    <>
      {plural(data.activeInstalls24h, "install")} in the last 24h
      {installsDelta && (
        <>
          {" · "}
          <DeltaText d={installsDelta} />
        </>
      )}
    </>
  );
  const crashDelta =
    data.previous.crashFreePct === null || data.crashFreePct === null
      ? null
      : deltaDetail(data.crashFreePct, data.previous.crashFreePct, {
          unit: "pts",
          range: prevRange,
        });
  const issuesDelta =
    data.previous.newIssues === null
      ? null
      : deltaDetail(data.newIssues, data.previous.newIssues, {
          upIsGood: false,
          unit: "count",
          range: prevRange,
        });
  const updateDelta = deltaDetail(data.updateFailures, data.previous.updateFailures, {
    upIsGood: false,
    unit: "count",
    range: prevRange,
  });

  return (
    <div>
      <h1 className="heading-32">{headline(data, filters)}</h1>
      {crashDelta && (
        <p className="headline-delta label-14 secondary">
          <DeltaText d={crashDelta} />
        </p>
      )}

      <div className="stat-strip">
        <Stat label="Active installs" value={String(data.activeInstalls)} detail={installsDetail} />
        <Stat
          label="New issues"
          value={String(data.newIssues)}
          detail={
            filters.version ? (
              `Filtered to ${filters.version}`
            ) : issuesDelta ? (
              <DeltaText d={issuesDelta} />
            ) : undefined
          }
        />
        <Stat
          label="Update failures"
          value={String(data.updateFailures)}
          detail={updateDelta && <DeltaText d={updateDelta} />}
        />
      </div>

      <section className="section" aria-labelledby="fix-first">
        <div className="section-head">
          <h2 id="fix-first" className="heading-20">
            What to fix first
          </h2>
          <span className="spacer" />
          <a
            className="section-link label-13"
            href="#/issues"
            onClick={(e) => {
              e.preventDefault();
              navigate({ view: "issues" }, filters);
            }}
          >
            View all issues
          </a>
        </div>
        {data.topIssues.length === 0 ? (
          <EmptyLine text="No issues in this range. Widen the time range or clear filters." />
        ) : (
          <IssueTable
            issues={data.topIssues}
            filters={filters}
            showKey={false}
            showStatus={false}
            caption="Top five issues by affected installs"
          />
        )}
      </section>

      <section className="section" aria-labelledby="per-day">
        <div className="section-head">
          <h2 id="per-day" className="heading-20">
            Problems per day
          </h2>
        </div>
        <div className="chart-labels" aria-hidden="true">
          <span>
            <span className="swatch" style={{ background: t.gray1000 }} />
            Crashes {totals.crashes}
          </span>
          <span>
            <span className="swatch" style={{ background: t.gray600 }} />
            Errors {totals.errors}
          </span>
          <span>
            <span className="swatch" style={{ background: t.gray500 }} />
            Update failures {totals.updateFailures}
          </span>
        </div>
        <EChart
          option={chartOptions!}
          height={240}
          ariaLabel="Stacked bar chart of crashes, errors, and update failures per day"
        />
        {caption && <p className="chart-caption">{caption}</p>}
      </section>

      <section className="section" aria-labelledby="latest-release">
        <div className="section-head">
          <h2 id="latest-release" className="heading-20">
            Latest release
          </h2>
        </div>
        {data.latestRelease === null ? (
          <EmptyLine text="No releases have reported yet." />
        ) : (
          <p className="copy-14">
            <span className="mono">{data.latestRelease.version}</span>
            <span className="secondary">
              {" · first seen "}
              {relativeTime(data.latestRelease.firstSeen)}
              {" · "}
              {plural(data.latestRelease.installs, "install")}
              {data.latestRelease.crashFreePct !== null &&
                ` · ${data.latestRelease.crashFreePct}% crash-free`}
              {" · "}
            </span>
            {data.latestRelease.installs < 5 ? (
              <span className="secondary">Too few installs to judge</span>
            ) : (
              <HealthWord health={data.latestRelease.health} />
            )}
          </p>
        )}
      </section>

      <section className="section" aria-labelledby="recent-activity">
        <div className="section-head">
          <h2 id="recent-activity" className="heading-20">
            Recent activity
          </h2>
        </div>
        {activityError ? (
          <ErrorState error={activityError} onRetry={retryActivity} />
        ) : activity === null ? (
          <Loading variant="list" />
        ) : activity.activity.length === 0 ? (
          <EmptyLine text="No errors, crashes, or lifecycle events in this range." />
        ) : (
          <ul className="activity-list">
            {activity.activity.slice(0, 10).map((event: ActivityEvent) => {
              const meta = (
                <span className="activity-meta">
                  {activityKindWord(event.event, event.kind)}
                  {" · "}
                  <span className="mono">{event.appVersion}</span>
                  {" · "}
                  {platformLabel(event.platform)}
                  {" · "}
                  {relativeTime(event.ts)}
                </span>
              );
              return (
                <li key={event.id}>
                  {event.issueKey ? (
                    <button
                      type="button"
                      className="activity-item"
                      onClick={() => navigate({ view: "issue", key: event.issueKey! }, filters)}
                    >
                      <span className="activity-title" title={event.title}>
                        {event.title}
                      </span>
                      {meta}
                    </button>
                  ) : (
                    <div className="activity-item">
                      <span className="activity-title" title={event.title}>
                        {event.title}
                      </span>
                      {meta}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
