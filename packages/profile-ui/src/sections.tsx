// FILE: sections.tsx
// Purpose: Small stat-display building blocks shared by the in-app profile panel and the
// public profile page: stat tiles, insight rows, and model-usage rows. App-specific
// visuals (provider icons) are injected as ReactNode slots so this package stays free of
// app dependencies.
// Layer: profile-ui shared components.

import type { ReactNode } from "react";
import { Skeleton } from "./skeleton";

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | null;
  /** Optional muted context under the label, e.g. "42.2m per active day". */
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 px-3 py-3">
      {value === null ? (
        <Skeleton className="h-4 w-12" />
      ) : (
        <span className="text-ui-lg leading-snug font-normal tabular-nums text-foreground">
          {value}
        </span>
      )}
      <span className="text-ui leading-snug font-normal text-muted-foreground">{label}</span>
      {detail ? (
        <span className="max-w-full truncate text-ui-sm leading-snug text-muted-foreground/80">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

const STAT_TILE_GRID_BASE =
  "grid grid-cols-2 divide-x divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60";

export function StatTileGrid({
  tiles,
  fitContainer = false,
}: {
  tiles: readonly { label: string; value: string | null; detail?: string }[];
  /**
   * Pick the column count from the grid's own width instead of the window's, for
   * grids in columns narrower than the window (settings). Off by default.
   */
  fitContainer?: boolean;
}) {
  const grid = (
    <div
      className={`${STAT_TILE_GRID_BASE} ${
        fitContainer
          ? "@lg:grid-cols-3 @2xl:grid-cols-5 @2xl:divide-y-0"
          : "sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0"
      }`}
    >
      {tiles.map((tile) => (
        <StatTile
          key={tile.label}
          label={tile.label}
          value={tile.value}
          {...(tile.detail ? { detail: tile.detail } : {})}
        />
      ))}
    </div>
  );
  return fitContainer ? <div className="@container">{grid}</div> : grid;
}

export function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-ui leading-snug text-muted-foreground">{label}</dt>
      <dd className="truncate text-ui leading-snug font-normal tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

export function ModelUsageRow({
  icon,
  model,
  percent,
  detail,
  stat,
  barColor,
}: {
  /** Leading provider/model icon, e.g. the web app's `<ProviderIcon />`. */
  icon: ReactNode;
  model: string;
  percent: number;
  /** Optional muted context after the model name, e.g. "Codex · xhigh". */
  detail?: string;
  /** Right-hand stat label; defaults to "{percent}%" (public page passes "17bn · 42%"). */
  stat?: string;
  /** Bar color; defaults to the owner's accent (`--info`). */
  barColor?: string;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-ui leading-snug">
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate">
            {model}
            {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{stat ?? `${percent}%`}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[var(--info)]"
          style={{
            width: `${Math.min(100, Math.max(2, percent))}%`,
            ...(barColor ? { background: barColor } : {}),
          }}
        />
      </div>
    </li>
  );
}
