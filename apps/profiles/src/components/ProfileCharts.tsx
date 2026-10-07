"use client";

// Minimal charts for the public profile, drawn as inline SVG/HTML: a thin-line daily area
// chart (tokens), slim daily bars (prompts), and the 24-hour activity bars. Hovering (or
// tapping) a point reads it out in a small tooltip. Every mark uses the owner's accent
// (`--info`). A client component only for the hover state; the data is computed on the server.

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

/** Prompts by hour of the owner's day. */
export function HourBars({ hours }: { hours: readonly { hour: number; prompts: number }[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const byHour = new Map(hours.map((entry) => [entry.hour, entry.prompts]));
  const max = Math.max(1, ...hours.map((entry) => entry.prompts));
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="relative" onPointerLeave={() => setHovered(null)}>
        <div className="flex h-16 items-end gap-[2px]" role="img" aria-label="Prompts by hour">
          {Array.from({ length: 24 }, (_, hour) => {
            const prompts = byHour.get(hour) ?? 0;
            return (
              <div
                key={hour}
                className="flex h-full flex-1 items-end"
                onPointerEnter={() => setHovered(hour)}
              >
                <div
                  className={`w-full rounded-t-[2px] transition-opacity ${prompts > 0 ? "bg-[var(--info)]" : "bg-muted"} ${hovered !== null && hovered !== hour ? "opacity-50" : ""}`}
                  style={{ height: `${Math.max(4, Math.round((prompts / max) * 100))}%` }}
                />
              </div>
            );
          })}
        </div>
        {hovered !== null ? (
          <ChartTooltip position={(hovered + 0.5) / 24}>
            <strong className="font-medium text-foreground">
              {plural(byHour.get(hovered) ?? 0, "prompt")}
            </strong>{" "}
            at {formatHourLabel(hovered)}
          </ChartTooltip>
        ) : null}
      </div>
      <div className="flex justify-between text-[11px] leading-none text-muted-foreground">
        {["12 AM", "6 AM", "12 PM", "6 PM", "11 PM"].map((label) => (
          <span key={label}>{label}</span>
        ))}
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
