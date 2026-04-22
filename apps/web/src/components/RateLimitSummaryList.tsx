// FILE: RateLimitSummaryList.tsx
// Purpose: Renders the compact rate-limit rows shared by the local popover and
// the dedicated rate-limit panel.

import { useMemo } from "react";

import type { ProviderRateLimit } from "~/lib/rateLimits";
import {
  deriveVisibleRateLimitRows,
  formatRateLimitRemainingPercent,
  formatRateLimitResetTime,
} from "~/lib/rateLimits";

export function RateLimitSummaryList({
  rateLimits,
}: {
  rateLimits: ReadonlyArray<ProviderRateLimit>;
}) {
  const rows = useMemo(() => deriveVisibleRateLimitRows(rateLimits), [rateLimits]);

  if (rows.length === 0) {
    return (
      <p className="text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground">
        No rate limit data yet.
      </p>
    );
  }

  return (
    <>
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-center justify-between text-[length:var(--app-font-size-chat,12px)]"
        >
          <span className="font-medium text-foreground">{row.label}</span>
          <span className="flex items-center gap-2 tabular-nums text-[length:var(--app-font-size-chat-meta,10px)] text-muted-foreground">
            <span className="text-foreground">
              {formatRateLimitRemainingPercent(row.remainingPercent)}
            </span>
            {row.resetsAt ? <span>{formatRateLimitResetTime(row.resetsAt)}</span> : null}
          </span>
        </div>
      ))}
    </>
  );
}
