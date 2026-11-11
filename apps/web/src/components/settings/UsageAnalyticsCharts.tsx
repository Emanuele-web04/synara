// FILE: UsageAnalyticsCharts.tsx
// Purpose: The Analytics tab's charts as hand-drawn SVG and HTML: a daily stacked bar
//          chart, smooth per-provider lines, and a weekday-by-hour grid. All three
//          share one hover tooltip and one provider legend, which hides or shows series.
// Layer: Web settings presentation
// Exports: ChartLegend, ChartTooltip, DailyBarChart, ProviderLineChart, RhythmChart

import { type ReactNode, useState } from "react";

import { useContainerSize } from "~/hooks/useContainerSize";
import { cn } from "~/lib/utils";
import {
  PROVIDER_SERIES_COLOR,
  providerLabel,
  type UsageAnalyticsDay,
  type UsageAnalyticsMetric,
  type UsageAnalyticsProvider,
} from "./usageAnalytics.logic";

// Charts draw at their measured pixel width so labels keep their real size; this is
// the width used before the first measurement.
const DEFAULT_VIEW_WIDTH = 800;
const MIN_VIEW_WIDTH = 240;
const PLOT_LEFT = 44;
const PLOT_TOP = 8;
const AXIS_GAP = 22;

type Format = (value: number) => string;

/** 1, 2 or 5 times a power of ten, at or above `value`. */
function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

function amountOf(
  value: { tokens: number; costUsd: number } | undefined,
  metric: UsageAnalyticsMetric,
): number {
  if (!value) return 0;
  return metric === "cost" ? value.costUsd : value.tokens;
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function longDayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Indexes of the days that get an x-axis label: first, last, and a few between. */
function labelIndexes(count: number): number[] {
  if (count <= 1) return [0];
  const marks = Math.min(5, count);
  return [
    ...new Set(
      Array.from({ length: marks }, (_, i) => Math.round((i * (count - 1)) / (marks - 1))),
    ),
  ];
}

// ── Shared pieces ──────────────────────────────────────────────────────

export interface ChartTooltipRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly color?: string;
}

/**
 * The hover card every chart uses. `left` is a CSS length inside the chart's
 * positioned wrapper; past the middle it opens to the left so it never clips.
 */
export function ChartTooltip(props: {
  left: string;
  top?: number;
  flip: boolean;
  title: string;
  rows: ReadonlyArray<ChartTooltipRow>;
  total?: { readonly label: string; readonly value: string };
}) {
  return (
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-10 w-52 rounded-lg border bg-popover px-3 py-2.5 shadow-md",
        props.flip ? "-translate-x-[calc(100%+10px)]" : "translate-x-2.5",
      )}
      style={{ left: props.left, top: props.top ?? 4 }}
    >
      <div className="pb-1.5 text-ui-sm font-medium text-foreground">{props.title}</div>
      {props.rows.length > 0 ? (
        <div className="space-y-1">
          {props.rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2 text-ui-sm">
              {row.color ? (
                <span className="size-2 shrink-0 rounded-[2px]" style={{ background: row.color }} />
              ) : null}
              <span className="flex-1 truncate text-muted-foreground">{row.label}</span>
              <span className="tabular-nums text-foreground">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {props.total ? (
        <div className="mt-1.5 flex justify-between border-t pt-1.5 text-ui-sm font-medium text-foreground">
          <span>{props.total.label}</span>
          <span className="tabular-nums">{props.total.value}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Provider legend; each entry hides or shows that provider's series in the charts. */
export function ChartLegend(props: {
  providers: ReadonlyArray<UsageAnalyticsProvider>;
  hidden: ReadonlySet<UsageAnalyticsProvider>;
  onToggle: (provider: UsageAnalyticsProvider) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {props.providers.map((provider) => {
        const shown = !props.hidden.has(provider);
        return (
          <button
            key={provider}
            type="button"
            aria-pressed={shown}
            title={shown ? `Hide ${providerLabel(provider)}` : `Show ${providerLabel(provider)}`}
            onClick={() => props.onToggle(provider)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-ui-sm transition-colors hover:bg-foreground/[0.05] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              shown ? "text-muted-foreground" : "text-muted-foreground/50 line-through",
            )}
          >
            <span
              className={cn("size-2 rounded-full", !shown && "opacity-40")}
              style={{ background: PROVIDER_SERIES_COLOR[provider] }}
            />
            {providerLabel(provider)}
          </button>
        );
      })}
    </div>
  );
}

function dayTooltipRows(
  day: UsageAnalyticsDay,
  providers: ReadonlyArray<UsageAnalyticsProvider>,
  metric: UsageAnalyticsMetric,
  format: Format,
): ChartTooltipRow[] {
  return providers
    .filter((provider) => amountOf(day.byProvider[provider], metric) > 0)
    .map((provider) => ({
      key: provider,
      label: providerLabel(provider),
      value: format(amountOf(day.byProvider[provider], metric)),
      color: PROVIDER_SERIES_COLOR[provider],
    }));
}

function ChartFrame(props: {
  width: number;
  height: number;
  max: number;
  format: Format;
  children: ReactNode;
  xLabels: ReadonlyArray<{ x: number; text: string; anchor: "start" | "middle" | "end" }>;
}) {
  const bottom = props.height - AXIS_GAP;
  return (
    <svg
      viewBox={`0 0 ${props.width} ${props.height}`}
      className="block h-auto w-full overflow-visible"
      role="presentation"
    >
      {[0, 0.5, 1].map((fraction) => {
        const y = bottom - fraction * (bottom - PLOT_TOP);
        return (
          <g key={fraction}>
            <line
              x1={PLOT_LEFT}
              x2={props.width - 4}
              y1={y}
              y2={y}
              className={fraction === 0 ? "stroke-border" : "stroke-border/60"}
              strokeWidth={1}
            />
            <text
              x={PLOT_LEFT - 8}
              y={y + 4}
              textAnchor="end"
              className="fill-muted-foreground text-ui-2xs tabular-nums"
            >
              {fraction === 0 ? "0" : props.format(props.max * fraction)}
            </text>
          </g>
        );
      })}
      {props.children}
      {props.xLabels.map((label) => (
        <text
          key={`${label.x}-${label.text}`}
          x={label.x}
          y={props.height - 4}
          textAnchor={label.anchor}
          className="fill-muted-foreground text-ui-2xs"
        >
          {label.text}
        </text>
      ))}
    </svg>
  );
}

function xAxisLabels(
  days: ReadonlyArray<UsageAnalyticsDay>,
  xAt: (index: number) => number,
): Array<{ x: number; text: string; anchor: "start" | "middle" | "end" }> {
  const indexes = labelIndexes(days.length);
  return indexes.map((index, position) => ({
    x: xAt(index),
    text: days[index] ? dayLabel(days[index].date) : "",
    anchor: position === 0 ? "start" : position === indexes.length - 1 ? "end" : "middle",
  }));
}

/** Invisible full-height columns, one per day, that report which day the pointer is over. */
function HoverColumns(props: {
  count: number;
  left: (index: number) => number;
  width: number;
  height: number;
  onHover: (index: number) => void;
}) {
  return Array.from({ length: props.count }, (_, index) => (
    <rect
      // Days are positional: the column index is the day.
      // oxlint-disable-next-line react/no-array-index-key
      key={index}
      x={props.left(index)}
      y={PLOT_TOP}
      width={props.width}
      height={props.height}
      fill="transparent"
      onMouseEnter={() => props.onHover(index)}
    />
  ));
}

/** The chart wrapper's element and the width to draw at, in pixels. */
function useChartWidth(fallback: number | undefined) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const size = useContainerSize(element);
  const width = Math.max(MIN_VIEW_WIDTH, Math.round(size?.width ?? fallback ?? DEFAULT_VIEW_WIDTH));
  return { ref: setElement, width };
}

// ── Charts ─────────────────────────────────────────────────────────────

interface DayChartProps {
  days: ReadonlyArray<UsageAnalyticsDay>;
  providers: ReadonlyArray<UsageAnalyticsProvider>;
  metric: UsageAnalyticsMetric;
  format: Format;
  /** Width before the first measurement, in pixels. */
  width?: number;
  /** Drawing height in pixels. */
  height?: number;
}

export function DailyBarChart(props: DayChartProps) {
  const { ref, width } = useChartWidth(props.width);
  const height = props.height ?? 220;
  const [hovered, setHovered] = useState<number | null>(null);
  const bottom = height - AXIS_GAP;
  const plotHeight = bottom - PLOT_TOP;
  const dayTotal = (day: UsageAnalyticsDay) =>
    props.providers.reduce(
      (sum, provider) => sum + amountOf(day.byProvider[provider], props.metric),
      0,
    );
  const max = niceCeiling(Math.max(0, ...props.days.map(dayTotal)));
  const step = (width - 4 - PLOT_LEFT) / Math.max(1, props.days.length);
  const barWidth = Math.max(1, step * 0.64);
  const hoveredDay = hovered === null ? null : props.days[hovered];

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHovered(null)}>
      <ChartFrame
        width={width}
        height={height}
        max={max}
        format={props.format}
        xLabels={xAxisLabels(props.days, (index) => PLOT_LEFT + index * step + step / 2)}
      >
        {props.days.map((day, index) => {
          const x = PLOT_LEFT + index * step + (step - barWidth) / 2;
          let y = bottom;
          return (
            <g key={day.key} opacity={hovered !== null && hovered !== index ? 0.45 : 1}>
              {/* Largest provider at the bottom of every stack. */}
              {props.providers.map((provider) => {
                const h = (amountOf(day.byProvider[provider], props.metric) / max) * plotHeight;
                if (h < 0.5) return null;
                y -= h;
                return (
                  <rect
                    key={provider}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(0.5, h - 1)}
                    rx={Math.min(2, barWidth / 3)}
                    style={{ fill: PROVIDER_SERIES_COLOR[provider] }}
                  />
                );
              })}
            </g>
          );
        })}
        <HoverColumns
          count={props.days.length}
          left={(index) => PLOT_LEFT + index * step}
          width={step}
          height={plotHeight}
          onHover={setHovered}
        />
      </ChartFrame>
      {hoveredDay && hovered !== null ? (
        <ChartTooltip
          left={`${((PLOT_LEFT + (hovered + 0.5) * step) / width) * 100}%`}
          flip={hovered > props.days.length / 2}
          title={longDayLabel(hoveredDay.date)}
          rows={dayTooltipRows(hoveredDay, props.providers, props.metric, props.format)}
          total={{ label: "Total", value: props.format(dayTotal(hoveredDay)) }}
        />
      ) : null}
    </div>
  );
}

/** Fritsch–Carlson monotone cubic through the points, as an SVG path (no overshoot below 0). */
function monotonePath(points: ReadonlyArray<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  if (points.length === 1) return `M${first.x} ${first.y}`;
  const slopes = points.slice(1).map((point, i) => {
    const previous = points[i]!;
    return (point.y - previous.y) / (point.x - previous.x);
  });
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]!;
    if (i === points.length - 1) return slopes[i - 1]!;
    const left = slopes[i - 1]!;
    const right = slopes[i]!;
    return left * right <= 0 ? 0 : (left + right) / 2;
  });
  for (let i = 0; i < slopes.length; i += 1) {
    const slope = slopes[i]!;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i]! / slope;
    const b = tangents[i + 1]! / slope;
    const sum = a * a + b * b;
    if (sum > 9) {
      const scale = 3 / Math.sqrt(sum);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  let path = `M${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const dx = (p1.x - p0.x) / 3;
    path += `C${(p0.x + dx).toFixed(1)} ${(p0.y + tangents[i]! * dx).toFixed(1)} ${(p1.x - dx).toFixed(1)} ${(p1.y - tangents[i + 1]! * dx).toFixed(1)} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return path;
}

export function ProviderLineChart(props: DayChartProps) {
  const { ref, width } = useChartWidth(props.width);
  const height = props.height ?? 220;
  const [hovered, setHovered] = useState<number | null>(null);
  const bottom = height - AXIS_GAP;
  const plotHeight = bottom - PLOT_TOP;
  const max = niceCeiling(
    Math.max(
      0,
      ...props.days.flatMap((day) =>
        props.providers.map((provider) => amountOf(day.byProvider[provider], props.metric)),
      ),
    ),
  );
  const span = Math.max(1, props.days.length - 1);
  const plotWidth = width - 4 - PLOT_LEFT;
  const xAt = (index: number) => PLOT_LEFT + (index / span) * plotWidth;
  const yAt = (value: number) => bottom - (value / max) * plotHeight;
  const column = plotWidth / Math.max(1, props.days.length);
  const hoveredDay = hovered === null ? null : props.days[hovered];

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHovered(null)}>
      <ChartFrame
        width={width}
        height={height}
        max={max}
        format={props.format}
        xLabels={xAxisLabels(props.days, xAt)}
      >
        {/* Largest first, so smaller series are drawn on top of its area. */}
        {props.providers.map((provider) => {
          const line = monotonePath(
            props.days.map((day, index) => ({
              x: xAt(index),
              y: yAt(amountOf(day.byProvider[provider], props.metric)),
            })),
          );
          const color = PROVIDER_SERIES_COLOR[provider];
          return (
            <g key={provider}>
              <path
                d={`${line}L${xAt(props.days.length - 1)} ${bottom}L${PLOT_LEFT} ${bottom}Z`}
                style={{ fill: color }}
                opacity={0.12}
              />
              <path d={line} style={{ stroke: color }} strokeWidth={1.75} fill="none" />
            </g>
          );
        })}
        {hoveredDay && hovered !== null ? (
          <g pointerEvents="none">
            <line
              x1={xAt(hovered)}
              x2={xAt(hovered)}
              y1={PLOT_TOP}
              y2={bottom}
              className="stroke-foreground/30"
              strokeDasharray="3 3"
            />
            {props.providers.map((provider) => (
              <circle
                key={provider}
                cx={xAt(hovered)}
                cy={yAt(amountOf(hoveredDay.byProvider[provider], props.metric))}
                r={3.5}
                className="fill-background"
                strokeWidth={2}
                style={{ stroke: PROVIDER_SERIES_COLOR[provider] }}
              />
            ))}
          </g>
        ) : null}
        <HoverColumns
          count={props.days.length}
          left={(index) => xAt(index) - column / 2}
          width={column}
          height={plotHeight}
          onHover={setHovered}
        />
      </ChartFrame>
      {hoveredDay && hovered !== null ? (
        <ChartTooltip
          left={`${(xAt(hovered) / width) * 100}%`}
          flip={hovered > props.days.length / 2}
          title={longDayLabel(hoveredDay.date)}
          rows={dayTooltipRows(hoveredDay, props.providers, props.metric, props.format)}
        />
      ) : null}
    </div>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const RHYTHM_ROW_PX = 20;

/** Tokens by local weekday and hour; the busiest hour uses the theme accent. */
export function RhythmChart(props: {
  rhythm: ReadonlyArray<ReadonlyArray<number>>;
  format: Format;
}) {
  const [hovered, setHovered] = useState<{ weekday: number; hour: number } | null>(null);
  const max = Math.max(0, ...props.rhythm.flat());
  let peak = { weekday: -1, hour: -1 };
  props.rhythm.forEach((hours, weekday) =>
    hours.forEach((value, hour) => {
      if (value > 0 && value === max && peak.weekday < 0) peak = { weekday, hour };
    }),
  );
  const columns = { gridTemplateColumns: "repeat(24, minmax(0, 1fr))" };
  const hoveredValue = hovered ? (props.rhythm[hovered.weekday]?.[hovered.hour] ?? 0) : 0;
  return (
    <div className="relative" role="presentation" onMouseLeave={() => setHovered(null)}>
      {WEEKDAYS.map((label, weekday) => {
        const hours = props.rhythm[weekday] ?? [];
        return (
          <div key={label} className="flex items-center gap-2" style={{ height: RHYTHM_ROW_PX }}>
            <span className="w-8 shrink-0 text-ui-2xs text-muted-foreground">{label}</span>
            <div className="grid h-full flex-1" style={columns}>
              {HOURS.map((hour) => {
                const share = max > 0 ? (hours[hour] ?? 0) / max : 0;
                const isPeak = peak.weekday === weekday && peak.hour === hour;
                const isHovered = hovered?.weekday === weekday && hovered.hour === hour;
                const size = share > 0 ? Math.max(3, 12 * Math.sqrt(share)) : 2.5;
                return (
                  <span
                    key={hour}
                    className="flex items-center justify-center"
                    onMouseEnter={() => setHovered({ weekday, hour })}
                  >
                    <span
                      className={cn(
                        "rounded-full",
                        isPeak ? "bg-info" : "bg-foreground",
                        isHovered && "ring-2 ring-foreground/25",
                      )}
                      style={{
                        width: size,
                        height: size,
                        opacity: isPeak || isHovered ? 1 : share > 0 ? 0.18 + 0.62 * share : 0.12,
                      }}
                    />
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2 pt-1.5">
        <span className="w-8 shrink-0" />
        <div className="grid flex-1 text-ui-2xs text-muted-foreground tabular-nums" style={columns}>
          {HOURS.map((hour) => (
            <span key={hour} className="text-center">
              {hour % 6 === 0 || hour === 23 ? String(hour).padStart(2, "0") : ""}
            </span>
          ))}
        </div>
      </div>
      {hovered ? (
        <ChartTooltip
          // The grid starts after the 2rem day label and its 0.5rem gap.
          left={`calc(2.5rem + ${(hovered.hour + 0.5) / 24} * (100% - 2.5rem))`}
          top={(hovered.weekday + 1) * RHYTHM_ROW_PX + 4}
          flip={hovered.hour >= 12}
          title={`${WEEKDAYS[hovered.weekday]} ${String(hovered.hour).padStart(2, "0")}:00–${String((hovered.hour + 1) % 24).padStart(2, "0")}:00`}
          rows={[{ key: "tokens", label: "Tokens", value: props.format(hoveredValue) }]}
        />
      ) : null}
    </div>
  );
}
