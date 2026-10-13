// FILE: InlineVisualCharts.tsx
// Purpose: The chart blocks of a native inline visual: labeled horizontal bars and a
//          measured, hoverable line chart. Drawn at the column's real pixel width so
//          text and strokes stay crisp at every size.
// Layer: Chat transcript row content
// Exports: InlineVisualBarChart, InlineVisualLineChart

import type { InlineVisualBlock } from "@synara/contracts";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

import { cn } from "~/lib/utils";

import { formatVisualNumber, niceAxisTicks } from "./inlineVisualBlocks.logic";
import {
  InlineVisualSurface,
  SeriesSwatch,
  seriesColor,
  toneTextClassName,
} from "./InlineVisualSurface";

type BarChartBlock = Extract<InlineVisualBlock, { type: "bar-chart" }>;
type LineChartBlock = Extract<InlineVisualBlock, { type: "line-chart" }>;

export function InlineVisualBarChart({ block }: { readonly block: BarChartBlock }) {
  const items =
    block.sort === "value" ? block.items.toSorted((a, b) => b.value - a.value) : block.items;
  const compared = items.some((item) => item.baseline !== undefined);
  const values = items.flatMap((item) => [item.value, item.baseline ?? 0]);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  // Normalize first so opposite, finite extreme values cannot overflow the span.
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
  const scaledMinimum = minimum / scale;
  const range = maximum / scale - scaledMinimum || 1;
  const zero = (-scaledMinimum / range) * 100;
  const anyHighlight = items.some((item) => item.highlight);
  const barStyle = (value: number) => ({
    marginLeft: `${((Math.min(0, value) / scale - scaledMinimum) / range) * 100}%`,
    width: `${(Math.abs(value / scale) / range) * 100}%`,
  });
  return (
    <InlineVisualSurface
      title={block.title}
      aside={
        compared ? (
          <span className="flex items-center gap-3 text-chat-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="h-1.5 w-3 rounded-full bg-[var(--chart-muted)]" />
              {block.baselineLabel ?? "Before"}
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="h-2 w-3 rounded-full bg-[var(--chart-accent)]" />
              {block.valueLabel ?? "After"}
            </span>
          </span>
        ) : null
      }
    >
      <div
        role="list"
        className={cn(
          "grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_max-content] items-center gap-x-3",
          compared ? "gap-y-3" : "gap-y-1.5",
        )}
      >
        {items.map((item, index) => {
          // In a before/after chart color tells before from after, so every
          // value bar keeps the accent and a highlight only weights the label.
          const emphasized = compared || item.highlight || !anyHighlight;
          return (
            <div role="listitem" key={`${item.label}:${index}`} className="contents">
              <span
                className={cn(
                  "max-w-48 truncate text-chat-sm",
                  item.highlight ? "font-medium text-foreground" : "text-muted-foreground",
                )}
                title={item.label}
              >
                {item.label}
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                {item.baseline !== undefined ? (
                  <span className="relative h-1.5 overflow-hidden rounded-full bg-[var(--chart-grid)]">
                    <span
                      className="block h-full rounded-full bg-[var(--chart-muted)]"
                      style={barStyle(item.baseline)}
                    />
                  </span>
                ) : null}
                <span className="relative h-2.5 overflow-hidden rounded-full bg-[var(--chart-grid)]">
                  {minimum < 0 ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 border-s border-foreground/40"
                      style={{ left: `${zero}%` }}
                    />
                  ) : null}
                  <span
                    className="block h-full rounded-full"
                    style={{
                      ...barStyle(item.value),
                      background: emphasized ? "var(--chart-accent)" : "var(--chart-muted)",
                    }}
                  />
                </span>
              </span>
              <span
                className={cn(
                  "text-right text-chat-sm tabular-nums",
                  item.highlight || compared
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {item.baseline !== undefined ? (
                  <BarChange
                    baseline={item.baseline}
                    value={item.value}
                    unit={block.unit}
                    better={block.better}
                  />
                ) : (
                  formatVisualNumber(item.value, { unit: block.unit })
                )}
              </span>
            </div>
          );
        })}
      </div>
    </InlineVisualSurface>
  );
}

/** "329 → 279 ms" with the relative change, colored when the agent said which way is better. */
function BarChange({
  baseline,
  value,
  unit,
  better,
}: {
  readonly baseline: number;
  readonly value: number;
  readonly unit: string | undefined;
  readonly better: BarChartBlock["better"];
}) {
  const change = baseline === 0 ? null : ((value - baseline) / Math.abs(baseline)) * 100;
  const improved =
    change === null || change === 0 || better === undefined
      ? null
      : better === "lower"
        ? change < 0
        : change > 0;
  return (
    <span className="flex flex-col items-end leading-tight">
      <span>
        <span className="font-normal text-muted-foreground">{formatVisualNumber(baseline)} → </span>
        {formatVisualNumber(value, { unit })}
      </span>
      {change !== null ? (
        <span
          className={cn(
            "text-chat-sm font-normal",
            improved === null
              ? "text-muted-foreground"
              : toneTextClassName(improved ? "success" : "danger"),
          )}
        >
          {change > 0 ? "+" : ""}
          {formatVisualNumber(change, { decimals: Math.abs(change) < 10 ? 1 : 0, unit: "%" })}
        </span>
      ) : null}
    </span>
  );
}

const LINE_CHART_HEIGHT = 184;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 24;

export function InlineVisualLineChart({ block }: { readonly block: LineChartBlock }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    setWidth(container.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const values = block.series.flatMap((series) =>
    series.values.filter((value): value is number => value !== null),
  );
  const ticks = niceAxisTicks(Math.min(...values), Math.max(...values));
  const low = ticks[0]!;
  const high = ticks[ticks.length - 1]!;
  const tickLabels = ticks.map((tick) => formatVisualNumber(tick));
  // Room for the widest tick label; approximate, the font is the chat font.
  const plotLeft = Math.max(...tickLabels.map((label) => label.length)) * 7 + 10;
  const plotRight = 8;
  const plotWidth = Math.max(0, width - plotLeft - plotRight);
  const plotHeight = LINE_CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;
  const count = block.labels.length;
  const x = (index: number) => plotLeft + (count === 1 ? 0 : (index / (count - 1)) * plotWidth);
  const y = (value: number) =>
    PLOT_TOP + plotHeight - ((value - low) / (high - low || 1)) * plotHeight;

  // First, last, and evenly spaced labels between, as many as fit.
  const labelSlots = Math.max(2, Math.min(count, Math.floor(plotWidth / 72)));
  const labelIndexes = new Set(
    Array.from({ length: labelSlots }, (_, slot) =>
      Math.round((slot / (labelSlots - 1)) * (count - 1)),
    ),
  );

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left - plotLeft;
    const index = Math.round((offset / (plotWidth || 1)) * (count - 1));
    setHover(Math.min(count - 1, Math.max(0, index)));
  };

  return (
    <InlineVisualSurface
      title={block.title}
      aside={
        block.series.length > 1 ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {block.series.map((series, index) => (
              <span
                key={series.name}
                className="flex items-center gap-1.5 text-chat-sm text-muted-foreground"
              >
                <SeriesSwatch index={index} />
                {series.name}
              </span>
            ))}
          </span>
        ) : null
      }
    >
      <div ref={containerRef} className="relative">
        {width > 0 ? (
          <svg
            width={width}
            height={LINE_CHART_HEIGHT}
            viewBox={`0 0 ${width} ${LINE_CHART_HEIGHT}`}
            className="block touch-pan-y overflow-visible"
            role="img"
            aria-label={block.title ?? block.series.map((series) => series.name).join(", ")}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((tick, index) => (
              <g key={tick}>
                <line
                  x1={plotLeft}
                  x2={plotLeft + plotWidth}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="var(--chart-grid)"
                />
                <text
                  x={plotLeft - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-chat-sm tabular-nums"
                >
                  {tickLabels[index]}
                </text>
              </g>
            ))}
            {block.labels.map((label, index) =>
              labelIndexes.has(index) ? (
                <text
                  key={`${label}:${index}`}
                  x={x(index)}
                  y={LINE_CHART_HEIGHT - 6}
                  textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
                  className="fill-muted-foreground text-chat-sm"
                >
                  {label}
                </text>
              ) : null,
            )}
            {block.series.map((series, seriesIndex) => (
              <path
                key={series.name}
                d={linePath(series.values, x, y)}
                fill="none"
                stroke={seriesColor(seriesIndex)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {hover !== null ? (
              <g>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PLOT_TOP}
                  y2={PLOT_TOP + plotHeight}
                  stroke="var(--rule)"
                />
                {block.series.map((series, seriesIndex) => {
                  const value = series.values[hover];
                  return value === null || value === undefined ? null : (
                    <circle
                      key={series.name}
                      cx={x(hover)}
                      cy={y(value)}
                      r={3.5}
                      fill="var(--background)"
                      stroke={seriesColor(seriesIndex)}
                      strokeWidth={2}
                    />
                  );
                })}
              </g>
            ) : null}
          </svg>
        ) : (
          <div style={{ height: LINE_CHART_HEIGHT }} />
        )}
        {hover !== null ? (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-28 rounded-lg border border-border/70 bg-popover px-2.5 py-1.5 text-chat-sm shadow-md"
            style={
              x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }
            }
          >
            <div className="mb-0.5 text-muted-foreground">{block.labels[hover]}</div>
            {block.series.map((series, seriesIndex) => (
              <div key={series.name} className="flex items-center gap-2">
                {block.series.length > 1 ? <SeriesSwatch index={seriesIndex} /> : null}
                <span className="min-w-0 flex-1 truncate">
                  {block.series.length > 1 ? series.name : null}
                </span>
                <span className="font-medium tabular-nums">
                  {formatVisualNumber(series.values[hover] ?? Number.NaN, { unit: block.unit })}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </InlineVisualSurface>
  );
}

/** A polyline that breaks at null values instead of bridging the gap. */
function linePath(
  values: ReadonlyArray<number | null>,
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let path = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    drawing = true;
  });
  return path;
}
