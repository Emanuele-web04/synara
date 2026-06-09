// FILE: UsageProgressTrack.tsx
// Purpose: Shared remaining-quota progress track with an optional expected-pace marker.
// Used by Settings and compact picker usage views so marker placement stays consistent.

import { cn } from "~/lib/utils";

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function UsageProgressTrack({
  label,
  remainingPercent,
  markerPercent,
  className,
  fillClassName,
  markerClassName,
  markerGapClassName = "bg-background",
}: {
  label: string;
  remainingPercent: number;
  markerPercent?: number | null | undefined;
  className?: string | undefined;
  fillClassName: string;
  markerClassName: string;
  markerGapClassName?: string | undefined;
}) {
  const clamped = clampPercent(remainingPercent);
  const marker =
    markerPercent === null || markerPercent === undefined ? null : clampPercent(markerPercent);
  const showMarker = marker !== null && clamped > 0 && clamped < 100;

  return (
    <div
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", fillClassName)}
        style={{ width: `${clamped}%` }}
      />
      {showMarker ? (
        <div
          className={cn(
            "absolute inset-y-0 z-10 flex w-2 -translate-x-1/2 items-center justify-center",
            markerGapClassName,
          )}
          style={{ left: `${marker}%` }}
          aria-hidden
        >
          <span className={cn("h-full w-0.5 rounded-full shadow-sm", markerClassName)} />
        </div>
      ) : null}
    </div>
  );
}
