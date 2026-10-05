// FILE: ProfileModelSpeedRow.tsx
// Purpose: One model's row in the Profile "Model speed" section: last-7-days tok/s with
// the change against the 7 days before, a 12-week trend, and lifetime tok/s and turns.
// Layer: web profile feature.

import type { ProfileModelSpeed, ProfileModelSpeedWeek } from "@synara/contracts";
import { formatModelSpeed } from "@synara/shared/modelSpeed";

import { ProviderIcon } from "~/components/ProviderIcon";
import { CentralIcon } from "~/lib/central-icons";
import { MiniBarChart } from "../MiniBarChart";
import { Badge } from "../ui/badge";
import { formatNumber, formatProfileModelName, formatShortDate } from "./profileFormatting";

/** "↑ 8%", "↓ 3%", "→ 0%"; null when there is nothing to compare. */
export function formatModelSpeedChange(changePercent: number | null): string | null {
  if (changePercent === null) return null;
  const arrow = changePercent > 0 ? "↑" : changePercent < 0 ? "↓" : "→";
  return `${arrow} ${Math.abs(changePercent)}%`;
}

export function formatModelSpeedWeekTooltip(week: ProfileModelSpeedWeek): string {
  const date = `Week of ${formatShortDate(week.weekStart) ?? week.weekStart}`;
  if (week.tokensPerSecond === null) {
    return week.turnCount > 0
      ? `${date}: not enough data (${formatNumber(week.turnCount)} turns)`
      : `${date}: no measured turns`;
  }
  const turns = `${formatNumber(week.turnCount)} ${week.turnCount === 1 ? "turn" : "turns"}`;
  return `${date}: ${formatModelSpeed(week.tokensPerSecond)} · ${turns}`;
}

export function ProfileModelSpeedRow({ entry }: { entry: ProfileModelSpeed }) {
  const change = formatModelSpeedChange(entry.changePercent);
  const lastWeekIndex = entry.weeks.length - 1;
  const lifetimeTurns = entry.lifetime.turnCount;
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-ui leading-snug">
        <span className="flex min-w-0 items-center gap-2">
          {entry.provider !== "unknown" ? (
            <ProviderIcon provider={entry.provider} className="size-3.5 shrink-0" />
          ) : (
            <CentralIcon name="chart-2" className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{formatProfileModelName(entry.provider, entry.model)}</span>
          {entry.fastMode ? (
            <Badge variant="info" size="sm">
              Fast
            </Badge>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums">
          {entry.last7Days.tokensPerSecond !== null
            ? formatModelSpeed(entry.last7Days.tokensPerSecond)
            : "—"}
          {change ? <span className="ml-1.5 text-muted-foreground">{change}</span> : null}
        </span>
      </div>
      <MiniBarChart
        className="h-6"
        bars={entry.weeks.map((week, index) => ({
          key: week.weekStart,
          value: week.tokensPerSecond ?? 0,
          tone:
            week.tokensPerSecond === null ? "empty" : index === lastWeekIndex ? "strong" : "muted",
          tooltip: formatModelSpeedWeekTooltip(week),
        }))}
      />
      <div className="flex justify-between gap-3 text-ui-sm leading-snug text-muted-foreground tabular-nums">
        <span>Last 7 days, 12-week trend</span>
        <span>
          Lifetime{" "}
          {entry.lifetime.tokensPerSecond !== null
            ? formatModelSpeed(entry.lifetime.tokensPerSecond)
            : "—"}{" "}
          · {formatNumber(lifetimeTurns)} {lifetimeTurns === 1 ? "turn" : "turns"}
        </span>
      </div>
    </li>
  );
}
