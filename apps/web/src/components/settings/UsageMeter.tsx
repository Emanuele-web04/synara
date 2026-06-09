// FILE: UsageMeter.tsx
// Purpose: A single usage row with a linear progress bar: a label + health dot, a filled
// track showing remaining quota, and "X% left" / "Resets in ..." captions. Used by the
// Settings usage panel so users can visibly see remaining quota per window.

import { formatRateLimitResetCountdown } from "~/lib/rateLimits";
import { deriveUsagePace, type UsagePaceStatus } from "~/lib/usagePace";
import { cn } from "~/lib/utils";

// Remaining-quota health: green when healthy, amber when low, red when nearly exhausted.
function meterTone(remainingPercent: number): string {
  if (remainingPercent <= 10) {
    return "bg-red-500";
  }
  if (remainingPercent <= 25) {
    return "bg-amber-500";
  }
  return "bg-emerald-500";
}

function paceTone(status: UsagePaceStatus): string {
  switch (status) {
    case "behind":
      return "bg-red-500";
    case "on-track":
      return "bg-amber-500";
    case "ahead":
      return "bg-emerald-500";
  }
}

export function UsageMeter({
  label,
  remainingPercent,
  resetsAt,
  windowDurationMins,
}: {
  label: string;
  remainingPercent: number;
  resetsAt?: string | undefined;
  windowDurationMins?: number | undefined;
}) {
  const clamped = Math.min(100, Math.max(0, remainingPercent));
  const pace = deriveUsagePace({ remainingPercent: clamped, resetsAt, windowDurationMins });
  const tone = meterTone(clamped);
  const dotTone = pace ? paceTone(pace.status) : tone;
  const countdown = resetsAt ? formatRateLimitResetCountdown(resetsAt) : "";
  const marker = pace ? Math.min(100, Math.max(0, pace.expectedRemainingPercent)) : null;
  const showMarker = marker !== null && clamped > 0 && clamped < 100;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span
          className={cn("size-1.5 shrink-0 rounded-full", dotTone)}
          title={pace ? `Usage pace: ${pace.status}` : undefined}
          aria-hidden
        />
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", tone)}
          style={{ width: `${clamped}%` }}
        />
        {showMarker ? (
          <div
            className="absolute inset-y-0 z-10 flex w-2 -translate-x-1/2 items-center justify-center bg-background"
            style={{ left: `${marker}%` }}
            aria-hidden
          >
            <span className={cn("h-full w-0.5 rounded-full shadow-sm", dotTone)} />
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{Math.round(clamped)}% left</span>
        {countdown ? <span>{countdown}</span> : null}
      </div>
      {pace?.amountText || pace?.etaText ? (
        <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
          {pace.amountText ? <span>{pace.amountText}</span> : <span />}
          {pace.etaText ? <span>{pace.etaText}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
