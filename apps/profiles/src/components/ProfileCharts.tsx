"use client";

// Minimal charts for the public profile, drawn as inline SVG/HTML: a thin-line daily area
// chart (tokens), slim daily bars (prompts), the model-share ring, the hour-of-day arc and
// the weekly capsules. Hovering (or tapping) a point reads it out. Every mark uses the
// owner's accent (`--info`). A client component only for the hover state; the data is
// computed on the server.

import { useState, type ReactNode } from "react";
import { formatCompact, formatHourLabel } from "@synara/profile-ui/formatting";
import type { DailyPoint } from "../lib/dailySeries";

const AREA_WIDTH = 640;
const AREA_HEIGHT = 120;

// Fixed English, UTC: the page copy is English, and the server render and the visitor's
// browser must print the same label (a locale-default formatter would differ by visitor).
const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return year && month && date ? DAY_LABEL.format(new Date(Date.UTC(year, month - 1, date))) : day;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? noun : `${noun}s`}`;
}

/** Tokens per day as a faint accent area under a thin line. */
export function DailyAreaChart({ points }: { points: readonly DailyPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((point) => point.tokens));
  const step = points.length > 1 ? AREA_WIDTH / (points.length - 1) : 0;
  // Headroom so the peak never touches the label above.
  const y = (value: number) => AREA_HEIGHT - (value / max) * (AREA_HEIGHT * 0.92);
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${y(point.tokens).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${AREA_WIDTH},${AREA_HEIGHT} L0,${AREA_HEIGHT} Z`;
  const active = hovered === null ? null : points[hovered];

  return (
    <figure className="m-0 flex flex-col gap-2">
      <div
        className="relative"
        onPointerLeave={() => setHovered(null)}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width);
          setHovered(
            Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))),
          );
        }}
      >
        <svg
          viewBox={`0 0 ${AREA_WIDTH} ${AREA_HEIGHT}`}
          preserveAspectRatio="none"
          className="block h-28 w-full overflow-visible"
          role="img"
          aria-label="Tokens per day"
        >
          <path d={area} fill="var(--info)" fillOpacity="0.14" />
          <path
            d={line}
            fill="none"
            stroke="var(--info)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {active && hovered !== null ? (
            <line
              x1={hovered * step}
              x2={hovered * step}
              y1={0}
              y2={AREA_HEIGHT}
              stroke="currentColor"
              strokeOpacity="0.18"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {active && hovered !== null ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--info)] ring-2 ring-background"
              style={{
                left: `${(hovered / Math.max(1, points.length - 1)) * 100}%`,
                top: `${(y(active.tokens) / AREA_HEIGHT) * 100}%`,
              }}
            />
            <ChartTooltip position={hovered / Math.max(1, points.length - 1)}>
              <strong className="font-medium text-foreground">
                {formatCompact(active.tokens)} tokens
              </strong>{" "}
              {dayLabel(active.day)}
            </ChartTooltip>
          </>
        ) : null}
      </div>
      <ChartAxis points={points} />
    </figure>
  );
}

/** Prompts per day as slim accent bars; empty days keep a faint stub. */
export function DailyBarChart({ points }: { points: readonly DailyPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((point) => point.prompts));
  const active = hovered === null ? null : points[hovered];
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="relative" onPointerLeave={() => setHovered(null)}>
        <div className="flex h-28 items-end gap-[2px]" role="img" aria-label="Prompts per day">
          {points.map((point, index) => (
            <div
              key={point.day}
              className="flex h-full flex-1 items-end"
              onPointerEnter={() => setHovered(index)}
            >
              <div
                className={`w-full rounded-t-[2px] transition-opacity ${point.prompts > 0 ? "bg-[var(--info)]" : "bg-muted"} ${hovered !== null && hovered !== index ? "opacity-50" : ""}`}
                style={{ height: `${Math.max(2, Math.round((point.prompts / max) * 100))}%` }}
              />
            </div>
          ))}
        </div>
        {active && hovered !== null ? (
          <ChartTooltip position={(hovered + 0.5) / points.length}>
            <strong className="font-medium text-foreground">
              {plural(active.prompts, "prompt")}
            </strong>{" "}
            {dayLabel(active.day)}
          </ChartTooltip>
        ) : null}
      </div>
      <ChartAxis points={points} />
    </figure>
  );
}

/** One slice of the model ring; `rest` marks the "Other models" slice, drawn muted. */
export type ModelShare = { key: string; label: string; tokens: number; rest?: boolean };

const RING_RADIUS = 56;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Opacity steps of the accent per slice, largest first. */
const RING_OPACITY = [1, 0.62, 0.36];

/**
 * Share of tokens as a ring with round-capped slices and small gaps. Hovering a slice
 * or its legend row reads that model out in the middle of the ring.
 */
export function ModelShareRing({
  shares,
  total,
}: {
  shares: readonly ModelShare[];
  total: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const safeTotal = Math.max(1, total);
  const gap = shares.length > 1 ? 9 : 0;
  let used = 0;
  const slices = shares.map((share, index) => {
    const length = (share.tokens / safeTotal) * RING_CIRCUMFERENCE;
    const slice = {
      ...share,
      percent: Math.round((share.tokens / safeTotal) * 100),
      dash: `${Math.max(0.1, length - gap).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
      offset: (-used - gap / 2).toFixed(2),
      opacity: RING_OPACITY[index] ?? 0.36,
    };
    used += length;
    return slice;
  });
  const active = hovered === null ? null : slices[hovered];

  return (
    <div className="flex items-center gap-7" onPointerLeave={() => setHovered(null)}>
      <div className="relative size-[132px] shrink-0">
        <svg
          viewBox="0 0 132 132"
          className="size-full -rotate-90"
          role="img"
          aria-label="Share of tokens by model"
        >
          {slices.map((slice, index) => (
            <circle
              key={slice.key}
              cx="66"
              cy="66"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={slice.dash}
              strokeDashoffset={slice.offset}
              className={`transition-opacity ${slice.rest ? "stroke-muted-foreground/25" : "stroke-[var(--info)]"}`}
              style={{
                opacity:
                  hovered !== null && hovered !== index ? 0.3 : slice.rest ? 1 : slice.opacity,
              }}
              onPointerEnter={() => setHovered(index)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-5 text-center">
          <span className="text-xl leading-tight tabular-nums">
            {active ? `${active.percent}%` : shares.length}
          </span>
          <span className="max-w-full truncate text-[11px] text-muted-foreground">
            {active ? active.label : shares.length === 1 ? "model" : "models"}
          </span>
        </div>
      </div>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-2.5 p-0 text-[13px]">
        {slices.map((slice, index) => (
          <li
            key={slice.key}
            className="flex min-w-0 items-center gap-2"
            onPointerEnter={() => setHovered(index)}
          >
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${slice.rest ? "bg-muted-foreground/25" : "bg-[var(--info)]"}`}
              style={slice.rest ? undefined : { opacity: slice.opacity }}
            />
            <span className="truncate">{slice.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{slice.percent}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ARC_WIDTH = 280;
const ARC_RADIUS = 128;

/**
 * Prompts by hour of the owner's day as 24 dots on a half circle, midnight on the left,
 * 11 PM on the right; a dot grows with its hour's prompts. The middle reads the busiest
 * hour, or the hovered one.
 */
export function HourArc({ hours }: { hours: readonly { hour: number; prompts: number }[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const byHour = new Map(hours.map((entry) => [entry.hour, entry.prompts]));
  const max = Math.max(0, ...hours.map((entry) => entry.prompts));
  const busiest = max > 0 ? (hours.find((entry) => entry.prompts === max)?.hour ?? null) : null;
  const shown = hovered ?? busiest;

  return (
    <figure
      className="m-0 flex flex-col items-center gap-2"
      onPointerLeave={() => setHovered(null)}
    >
      <div className="relative h-[150px] w-[280px]">
        <svg
          viewBox={`0 0 ${ARC_WIDTH} 150`}
          className="size-full overflow-visible"
          role="img"
          aria-label="Prompts by hour"
        >
          {Array.from({ length: 24 }, (_, hour) => {
            const prompts = byHour.get(hour) ?? 0;
            const angle = Math.PI + (hour / 23) * Math.PI;
            const radius = prompts > 0 ? 2.5 + (prompts / Math.max(1, max)) * 6 : 2;
            return (
              <g key={hour} onPointerEnter={() => setHovered(hour)}>
                {/* A fixed-size hit area so small dots stay easy to hover. */}
                <circle
                  cx={ARC_WIDTH / 2 + ARC_RADIUS * Math.cos(angle)}
                  cy={142 + ARC_RADIUS * Math.sin(angle)}
                  r="10"
                  fill="transparent"
                />
                <circle
                  cx={ARC_WIDTH / 2 + ARC_RADIUS * Math.cos(angle)}
                  cy={142 + ARC_RADIUS * Math.sin(angle)}
                  r={radius}
                  className={`transition-opacity ${prompts > 0 ? "fill-[var(--info)]" : "fill-muted-foreground/20"}`}
                  style={{
                    opacity: prompts === 0 || hour === shown ? 1 : hovered !== null ? 0.35 : 0.55,
                  }}
                />
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-0.5">
          <span className="text-xl leading-tight">
            {shown === null ? "—" : formatHourLabel(shown)}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {hovered !== null
              ? plural(byHour.get(hovered) ?? 0, "prompt")
              : busiest !== null
                ? "busiest hour"
                : "no prompts yet"}
          </span>
        </div>
      </div>
      <div className="flex w-[280px] justify-between text-[10px] leading-none text-muted-foreground">
        <span>12 AM</span>
        <span>12 PM</span>
        <span>11 PM</span>
      </div>
    </figure>
  );
}

/** One week of the heatmap window: its first day and its tokens. */
export type WeekPoint = { start: string; tokens: number };

/** Tokens per week as rounded capsules that fill from the bottom. */
export function WeekCapsules({ weeks }: { weeks: readonly WeekPoint[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...weeks.map((week) => week.tokens));
  const active = hovered === null ? null : weeks[hovered];
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="relative" onPointerLeave={() => setHovered(null)}>
        <div className="flex h-[72px] gap-[3px] sm:gap-1" role="img" aria-label="Tokens per week">
          {weeks.map((week, index) => (
            <div
              key={week.start}
              className={`flex flex-1 items-end overflow-hidden rounded-full bg-muted transition-opacity ${hovered !== null && hovered !== index ? "opacity-50" : ""}`}
              onPointerEnter={() => setHovered(index)}
            >
              {week.tokens > 0 ? (
                <div
                  className="w-full rounded-full bg-[var(--info)]"
                  style={{ height: `${Math.max(16, Math.round((week.tokens / max) * 100))}%` }}
                />
              ) : null}
            </div>
          ))}
        </div>
        {active && hovered !== null ? (
          <ChartTooltip position={(hovered + 0.5) / weeks.length}>
            <strong className="font-medium text-foreground">
              {formatCompact(active.tokens)} tokens
            </strong>{" "}
            week of {dayLabel(active.start)}
          </ChartTooltip>
        ) : null}
      </div>
      <div className="flex justify-between text-[11px] leading-none text-muted-foreground">
        <span>{weeks[0] ? dayLabel(weeks[0].start) : ""}</span>
        <span>This week</span>
      </div>
    </figure>
  );
}

/** A small pill above the chart at `position` (0–1 across its width), kept inside the edges. */
function ChartTooltip({ position, children }: { position: number; children: ReactNode }) {
  const clamped = Math.min(0.88, Math.max(0.12, position));
  return (
    <div
      role="status"
      className="pointer-events-none absolute -top-8 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--tile)] px-2 py-1 text-[11px] tabular-nums text-muted-foreground shadow-sm ring-1 ring-[var(--hairline)] backdrop-blur"
      style={{ left: `${clamped * 100}%` }}
    >
      {children}
    </div>
  );
}

function ChartAxis({ points }: { points: readonly DailyPoint[] }) {
  const first = points[0];
  return (
    <div className="flex justify-between text-[11px] leading-none text-muted-foreground">
      <span>{first ? dayLabel(first.day) : ""}</span>
      <span>Today</span>
    </div>
  );
}
