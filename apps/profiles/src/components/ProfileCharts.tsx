// Small, dependency-free charts for the public profile, drawn as inline SVG/HTML so the
// page stays server-rendered: a daily area chart (tokens), daily bars (prompts), and the
// 24-hour activity bars. Every mark uses the owner's accent (`--info`).

import { formatCompact, formatHourLabel, formatShortDate } from "@synara/profile-ui/formatting";
import type { DailyPoint } from "../lib/dailySeries";

const AREA_WIDTH = 640;
const AREA_HEIGHT = 160;

/** Tokens per day as a soft accent area with a crisp top line. */
export function DailyAreaChart({ points }: { points: readonly DailyPoint[] }) {
  const max = Math.max(1, ...points.map((point) => point.tokens));
  const step = points.length > 1 ? AREA_WIDTH / (points.length - 1) : 0;
  // Leave headroom so the peak never touches the card's top padding.
  const y = (value: number) => AREA_HEIGHT - (value / max) * (AREA_HEIGHT * 0.9);
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${y(point.tokens).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${AREA_WIDTH},${AREA_HEIGHT} L0,${AREA_HEIGHT} Z`;

  return (
    <figure className="m-0 flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${AREA_WIDTH} ${AREA_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-40 w-full overflow-visible"
        role="img"
        aria-label="Tokens per day"
      >
        <defs>
          <linearGradient id="profile-area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--info)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#profile-area-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--info)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((point, index) => (
          <rect
            key={point.day}
            x={index * step - step / 2}
            y={0}
            width={Math.max(step, 1)}
            height={AREA_HEIGHT}
            fill="transparent"
          >
            <title>{`${formatCompact(point.tokens)} tokens on ${formatShortDate(point.day) ?? point.day}`}</title>
          </rect>
        ))}
      </svg>
      <ChartAxis points={points} />
    </figure>
  );
}

/** Prompts per day as rounded accent bars; empty days keep a faint stub. */
export function DailyBarChart({ points }: { points: readonly DailyPoint[] }) {
  const max = Math.max(1, ...points.map((point) => point.prompts));
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="flex h-36 items-end gap-[3px]" role="img" aria-label="Prompts per day">
        {points.map((point) => (
          <div
            key={point.day}
            title={`${point.prompts.toLocaleString("en-US")} ${point.prompts === 1 ? "prompt" : "prompts"} on ${formatShortDate(point.day) ?? point.day}`}
            className={`flex-1 rounded-[4px] ${point.prompts > 0 ? "bg-[var(--info)]" : "bg-muted"}`}
            style={{ height: `${Math.max(3, Math.round((point.prompts / max) * 100))}%` }}
          />
        ))}
      </div>
      <ChartAxis points={points} />
    </figure>
  );
}

/** Prompts by hour of the owner's day. */
export function HourBars({ hours }: { hours: readonly { hour: number; prompts: number }[] }) {
  const byHour = new Map(hours.map((entry) => [entry.hour, entry.prompts]));
  const max = Math.max(1, ...hours.map((entry) => entry.prompts));
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="flex h-20 items-end gap-[3px]" role="img" aria-label="Prompts by hour">
        {Array.from({ length: 24 }, (_, hour) => {
          const prompts = byHour.get(hour) ?? 0;
          return (
            <div
              key={hour}
              title={`${prompts.toLocaleString("en-US")} ${prompts === 1 ? "prompt" : "prompts"} at ${formatHourLabel(hour)}`}
              className={`flex-1 rounded-[3px] ${prompts > 0 ? "bg-[var(--info)]" : "bg-muted"}`}
              style={{ height: `${Math.max(4, Math.round((prompts / max) * 100))}%` }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] leading-none text-muted-foreground">
        {["12 AM", "6 AM", "12 PM", "6 PM", "11 PM"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </figure>
  );
}

function ChartAxis({ points }: { points: readonly DailyPoint[] }) {
  const first = points[0];
  return (
    <div className="flex justify-between text-[11px] leading-none text-muted-foreground">
      <span>{first ? (formatShortDate(first.day) ?? first.day) : ""}</span>
      <span>Today</span>
    </div>
  );
}
