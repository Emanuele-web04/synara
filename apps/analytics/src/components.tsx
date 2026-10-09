// FILE: src/components.tsx
// Purpose: Local primitives and shared helpers. Small components built on
// the Geist tokens in styles.css — no external UI kit. ECharts is the only
// chart dependency and is always styled through useChartTheme().

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as echarts from "echarts";
import { api, AuthError, EMPTY_FILTERS, type Filters, type Issue, type IssueStatus } from "./api";
import { navigate, routeHash } from "./filters";
import { createDebounced } from "./debounce";
import { useResolvedMode, type ResolvedMode } from "./theme";

export const DAY_OPTIONS = [
  { label: "24h", value: "1" },
  { label: "7d", value: "7" },
  { label: "30d", value: "30" },
  { label: "90d", value: "90" },
  { label: "All", value: "365" },
];

export const KIND_OPTIONS = [
  { label: "All kinds", value: "" },
  { label: "Errors", value: "error" },
  { label: "Crashes", value: "crash" },
  { label: "Update failures", value: "update" },
];

export const STATUS_OPTIONS = [
  { label: "Open", value: "open" },
  { label: "Resolved", value: "resolved" },
  { label: "Ignored", value: "ignored" },
  { label: "All", value: "all" },
];

export const KIND_LABELS: Record<string, string> = {
  error: "Error",
  crash: "Crash",
  update: "Update failure",
};

/** Short kind word for narrow Type columns ("Update failure" clips). */
const KIND_SHORT: Record<string, string> = {
  error: "Error",
  crash: "Crash",
  update: "Update",
};

/** Activity meta word keyed on the event name (the stored `kind` is "beta"
    for lifecycle rows, which means nothing to a reader). */
export function activityKindWord(event: string, kind: string): string {
  const words: Record<string, string> = {
    "app.error": "Error",
    "app.renderer-crash": "Crash",
    "app.child-process-crash": "Crash",
    "update.error": "Update failure",
    "beta.installed": "Install",
    "beta.left": "Left Beta",
  };
  return words[event] ?? KIND_LABELS[kind] ?? kind;
}

export function relativeTime(ts: string): string {
  const diff = Date.now() - Date.parse(ts);
  const mins = Math.max(1, Math.round(diff / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function RelTime({ ts }: { ts: string }) {
  return <span title={ts}>{relativeTime(ts)}</span>;
}

export function plural(n: number, word: string, pluralWord?: string): string {
  return `${n} ${n === 1 ? word : (pluralWord ?? `${word}s`)}`;
}

export function platformLabel(p: string): string {
  return p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p === "linux" ? "Linux" : p;
}

/** Shared data fetcher: resolves to data, an error string, or null while
    loading. Auth errors are handed to the caller's handler, not rendered. */
export function useApiData<T>(fetcher: () => Promise<T>, deps: unknown[], onAuthError: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [tick, setTick] = useState(0);
  const ref = useRef(fetcher);
  ref.current = fetcher;
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    ref
      .current()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onAuthError();
        else setError(e instanceof Error ? e.message : "Request failed");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return {
    data,
    error,
    busy,
    retry: () => {
      // Keep the stale data on screen — it dims while the refetch runs.
      setError(null);
      setTick((n) => n + 1);
    },
  };
}

/** Version/platform option lists for the filter bar. */
export function useFilterOptions(onAuthError: () => void) {
  const [versions, setVersions] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  useEffect(() => {
    api
      .filterOptions()
      .then((d) => {
        setVersions(d.versions);
        setPlatforms(d.platforms);
      })
      .catch((e) => {
        if (e instanceof AuthError) onAuthError();
      });
  }, [onAuthError]);
  return { versions, platforms };
}

export function rangeLabel(filters: Filters): string {
  return filters.days >= 365
    ? "all time"
    : `last ${filters.days === 1 ? "24h" : `${filters.days} days`}`;
}

/** True when every filter sits at its default — the filter sentence stays
    hidden in that case. */
export function filtersAreDefault(f: Filters): boolean {
  return f.days === EMPTY_FILTERS.days && !f.version && !f.platform && !f.kind && !f.q;
}

/** "Sep 17" — the year is appended only when the range crosses a boundary. */
export function dayLabel(day: string, showYear = false): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  });
}

/** Whether a day series crosses a year boundary (first vs last label). */
export function rangeSpansYears(days: { day: string }[]): boolean {
  return days.length > 0 && days[0]!.day.slice(0, 4) !== days[days.length - 1]!.day.slice(0, 4);
}

export function FilterBar({
  filters,
  onChange,
  onAuthError,
  fields,
  sentence,
  right,
}: {
  filters: Filters;
  onChange: (f: Partial<Filters>, opts?: { replace?: boolean }) => void;
  onAuthError: () => void;
  fields: ("days" | "version" | "platform" | "kind" | "status" | "search")[];
  sentence?: string;
  right?: ReactNode;
}) {
  const { versions, platforms } = useFilterOptions(onAuthError);
  // Controlled search: commits 300ms after the last keystroke via replaceState,
  // and resyncs when Back/Forward or a link changes filters.q.
  const [searchValue, setSearchValue] = useState(filters.q);
  useEffect(() => setSearchValue(filters.q), [filters.q]);
  const commitSearch = useRef(
    createDebounced((v: string) => onChange({ q: v }, { replace: true }), 300),
  );
  useEffect(() => () => commitSearch.current.cancel(), []);
  return (
    <div className="filter-row">
      {fields.includes("days") && (
        <span className="select-wrap">
          <select
            className="select"
            aria-label="Time range"
            value={String(filters.days)}
            onChange={(e) => onChange({ days: Number(e.target.value) })}
          >
            {DAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {!DAY_OPTIONS.some((o) => o.value === String(filters.days)) && (
              <option value={String(filters.days)}>{filters.days} days</option>
            )}
          </select>
        </span>
      )}
      {fields.includes("version") && (
        <span className="select-wrap">
          <select
            className="select"
            aria-label="Version"
            value={filters.version}
            onChange={(e) => onChange({ version: e.target.value })}
          >
            <option value="">All versions</option>
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            {filters.version && !versions.includes(filters.version) && (
              <option value={filters.version}>{filters.version} (no data)</option>
            )}
          </select>
        </span>
      )}
      {fields.includes("platform") && (
        <span className="select-wrap">
          <select
            className="select"
            aria-label="Platform"
            value={filters.platform}
            onChange={(e) => onChange({ platform: e.target.value })}
          >
            <option value="">All platforms</option>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {platformLabel(p)}
              </option>
            ))}
            {filters.platform && !platforms.includes(filters.platform) && (
              <option value={filters.platform}>{platformLabel(filters.platform)} (no data)</option>
            )}
          </select>
        </span>
      )}
      {fields.includes("kind") && (
        <span className="select-wrap">
          <select
            className="select"
            aria-label="Kind"
            value={filters.kind}
            onChange={(e) => onChange({ kind: e.target.value })}
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </span>
      )}
      {fields.includes("search") && (
        <input
          className="input"
          type="search"
          aria-label="Search"
          placeholder="Search"
          value={searchValue}
          onChange={(e) => {
            const v = e.target.value;
            setSearchValue(v);
            if (v.length === 0 || v.length > 2) commitSearch.current(v);
          }}
        />
      )}
      {sentence && <span className="filter-sentence label-13">{sentence}</span>}
      {right}
    </div>
  );
}

export function Button({
  variant = "secondary",
  type = "button",
  onClick,
  disabled,
  children,
}: {
  variant?: "primary" | "secondary" | "tertiary";
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button type={type} className={`btn btn-${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
}) {
  return (
    <div className="stat">
      <p className="stat-label label-13">{label}</p>
      <p className="stat-value heading-32 numeric">{value}</p>
      {detail && <p className="stat-detail label-13">{detail}</p>}
    </div>
  );
}

/** Delta phrasing: "Up 12% from the previous 30 days", "None in the
    previous 30 days". `worse` when movement runs against upIsGood. */
export function deltaDetail(
  current: number,
  previous: number | null,
  {
    upIsGood = true,
    unit = "pct",
    range,
  }: { upIsGood?: boolean; unit?: "pct" | "pts" | "count"; range: string },
): { delta: string; suffix: string; worse: boolean } | null {
  const suffix = `from the previous ${range}`;
  if (previous === null) return null;
  if (previous === 0) {
    return {
      delta: "None",
      suffix: `in the previous ${range}`,
      worse: false,
    };
  }
  if (current === previous) {
    return { delta: "No change", suffix, worse: false };
  }
  const up = current > previous;
  const worse = up ? !upIsGood : upIsGood;
  const dir = up ? "Up" : "Down";
  let amount: string;
  if (unit === "pts") {
    amount = `${Math.abs(Math.round((current - previous) * 10) / 10)} points`;
  } else if (unit === "count") {
    amount = `${Math.abs(current - previous)}`;
  } else {
    const pct = Math.abs(((current - previous) / previous) * 100);
    amount = pct > 500 ? ">500%" : `${Math.round(pct)}%`;
  }
  return { delta: `${dir} ${amount}`, suffix, worse };
}

/** Renders a deltaDetail result: only the Up/Down/None phrase carries color. */
export function DeltaText({ d }: { d: { delta: string; suffix: string; worse: boolean } }) {
  return (
    <>
      <span className={d.worse ? "worse" : undefined}>{d.delta}</span> {d.suffix}
    </>
  );
}

/** 80x24 sparkline, 1.25px currentColor stroke, no fill; dot for one point.
    `scaleMax` shares one scale across a column of rows. */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  color,
  scaleMax,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  scaleMax?: number;
}) {
  if (values.length === 0) return null;
  if (values.length === 1) {
    return (
      <svg
        className="sparkline"
        width={width}
        height={height}
        aria-hidden="true"
        style={color ? { color } : undefined}
      >
        <circle cx={width / 2} cy={height / 2} r={2} fill="currentColor" />
      </svg>
    );
  }
  const max = scaleMax ?? Math.max(1, ...values);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const points = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      aria-hidden="true"
      style={color ? { color } : { color: "var(--gray-1000)" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Quiet skeleton blocks matching the page's geometry; no shimmer. */
export function Loading({ variant = "page" }: { variant?: "page" | "list" }) {
  if (variant === "list") {
    return (
      <div className="skeleton-stack" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className="skeleton-block skeleton-row"
            style={{ width: `${88 - (i % 3) * 12}%` }}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton-block skeleton-h1" />
      <div className="skeleton-stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton-block skeleton-stat" />
        ))}
      </div>
      <div className="skeleton-block skeleton-chart" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton-block skeleton-row" style={{ width: `${90 - i * 10}%` }} />
      ))}
    </div>
  );
}

/** Muted one-liner for an empty section that keeps its heading. */
export function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <p className="error-line">
      {error}
      {onRetry && (
        <Button variant="tertiary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </p>
  );
}

/** Code/log block with a Copy button in the corner. */
export function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block-wrap">
      <Button
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // clipboard unavailable
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      <pre className="code-block label-13-mono">{text}</pre>
    </div>
  );
}

/** Same thresholds as worker.ts releaseHealth — the releases endpoint does
    not carry a health field, so rows compute it client-side. */
export function healthFor(
  crashFreePct: number | null,
  installs: number,
): "healthy" | "watch" | "unhealthy" | null {
  if (crashFreePct === null || installs <= 0) return null;
  return crashFreePct >= 99.5 ? "healthy" : crashFreePct >= 98 ? "watch" : "unhealthy";
}

/** Plain health word; only Watch/Unhealthy carry color. */
export function HealthWord({ health }: { health: string | null }) {
  if (health === "watch") return <span className="health-watch">Watch</span>;
  if (health === "unhealthy") return <span className="health-unhealthy">Unhealthy</span>;
  return <span>{health === "healthy" ? "Healthy" : "Unknown"}</span>;
}

/** The status word shared by the issues table and the detail meta line. */
export function issueStatusWord(issue: Issue): string {
  if (issue.isNew) return "New";
  const labels: Record<IssueStatus, string> = {
    open: "Open",
    resolved: "Resolved",
    ignored: "Ignored",
    regressed: "Regressed",
  };
  return labels[issue.status] ?? issue.status;
}

/** Status column word: only New/Regressed surface; plain open stays blank. */
export function StatusWord({ issue }: { issue: Issue }) {
  const word = issue.isNew ? "New" : issue.status === "regressed" ? "Regressed" : null;
  return word ? <span className="status-word">{word}</span> : null;
}

/** Horizontal scroller with a right-edge fade while more content exists. */
export function TableWrap({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setFading(
        el.scrollWidth > el.clientWidth + 1 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      );
    update();
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [children]);
  return (
    <div ref={ref} className={`table-wrap${fading ? " fading" : ""}`}>
      {children}
    </div>
  );
}

/** Full-width issues table shared by Overview (top 5) and the Issues page. */
export function IssueTable({
  issues,
  filters,
  showKey = true,
  showStatus = true,
  caption,
}: {
  issues: Issue[];
  filters: Filters;
  showKey?: boolean;
  showStatus?: boolean;
  caption: string;
}) {
  // One sparkline scale per column: the column max, not a per-row max.
  const trendMax = Math.max(1, ...issues.flatMap((issue) => issue.trend));
  return (
    <TableWrap>
      <table className="data data-fixed">
        <caption className="visually-hidden">{caption}</caption>
        <colgroup>
          <col className="c-issue" />
          <col className="c-type" />
          {showStatus && <col className="c-status" />}
          <col className="c-users" />
          <col className="c-events" />
          <col className="c-trend col-hide-sm" />
          <col className="c-versions col-hide-sm" />
          <col className="c-last col-hide-sm" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Issue</th>
            <th scope="col">Type</th>
            {showStatus && <th scope="col">Status</th>}
            <th scope="col" className="num">
              Users
            </th>
            <th scope="col" className="num">
              Events
            </th>
            <th scope="col" className="col-hide-sm">
              Trend
            </th>
            <th scope="col" className="col-hide-sm">
              Versions
            </th>
            <th scope="col" className="col-hide-sm">
              Last seen
            </th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr key={issue.key} className="clickable">
              <td className="issue-title-cell">
                {/* Stretched link: covers the whole row so keyboard focus and
                    clicks both reach the issue detail. */}
                <a
                  className="issue-title-link"
                  href={routeHash({ view: "issue", key: issue.key }, filters)}
                >
                  <span className="t" title={issue.title}>
                    {issue.title}
                  </span>
                </a>
                {showKey && <span className="issue-key-line">{issue.key}</span>}
              </td>
              <td className="secondary">{KIND_SHORT[issue.kind] ?? issue.kind}</td>
              {showStatus && (
                <td>
                  <StatusWord issue={issue} />
                </td>
              )}
              <td className="num">{issue.users}</td>
              <td className="num">{issue.events}</td>
              <td className="col-hide-sm">
                <Sparkline values={issue.trend} scaleMax={trendMax} />
              </td>
              <td
                className="secondary mono col-hide-sm"
                title={issue.versions.length > 1 ? issue.versions.join(", ") : issue.firstVersion}
              >
                {issue.firstVersion}
                {issue.versions.length > 1 && (
                  <span className="secondary label-13"> +{issue.versions.length - 1}</span>
                )}
              </td>
              <td className="secondary col-hide-sm">
                <RelTime ts={issue.lastSeen} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/* ---- Chart theming ---- */

export interface ChartTheme {
  mode: ResolvedMode;
  text: string;
  sub: string;
  line: string;
  surface: string;
  gray1000: string;
  gray600: string;
  gray500: string;
  red700: string;
  amber900: string;
}

/** Reads the token values so echarts options follow the active theme. */
export function useChartTheme(): ChartTheme {
  const mode = useResolvedMode();
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const v = (name: string) => style.getPropertyValue(name).trim();
    return {
      mode,
      text: v("--text-primary") || "#000",
      sub: v("--text-secondary") || "#666",
      line: v("--hairline") || "rgba(0,0,0,0.08)",
      surface: v("--background-100") || "#fff",
      gray1000: v("--gray-1000") || "#000",
      gray600: v("--gray-600") || "#888",
      gray500: v("--gray-500") || "#999",
      red700: v("--red-700") || "#c00",
      amber900: v("--amber-900") || "#a60",
    };
  }, [mode]);
}

/** Shared echarts axis/grid/tooltip pieces in the token palette. */
export function chartChrome(t: ChartTheme) {
  return {
    grid: { left: 4, right: 4, top: 8, bottom: 4, containLabel: true },
    xAxis: {
      type: "category" as const,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: t.sub,
        fontSize: 11,
        fontFamily: "Geist",
        hideOverlap: true,
      },
    },
    yAxis: {
      type: "value" as const,
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.sub, fontSize: 11, fontFamily: "Geist" },
      splitLine: { lineStyle: { color: t.line, width: 1 } },
    },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: t.surface,
      borderColor: t.line,
      textStyle: { color: t.text, fontSize: 12, fontFamily: "Geist" },
    },
  };
}

/** Minimal echarts mount: re-set option on theme change, resize with parent. */
export function EChart({
  option,
  height,
  ariaLabel,
}: {
  option: echarts.EChartsOption;
  height: number;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const mode = useResolvedMode();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option, mode]);
  return <div ref={ref} style={{ height }} role="img" aria-label={ariaLabel} tabIndex={0} />;
}
