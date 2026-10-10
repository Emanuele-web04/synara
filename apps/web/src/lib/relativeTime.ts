// FILE: relativeTime.ts
// Purpose: Compact relative-time labels ("now", "5m", "3h", "2d", "1w", "5mo") for thread and
//          pull request lists, plus the snooze countdown label.
// Layer: Web UI utility

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Countdown label for a snoozed thread ("28 min left", "1 hr 28 min left", "2 days 1 hr left"). */
export function formatSnoozeRemainingTime(snoozedUntil: string, nowMs: number): string {
  const remainingMs = Date.parse(snoozedUntil) - nowMs;
  if (!(remainingMs > 0)) return "Returning…";
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return "Less than a minute left";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts =
    days > 0
      ? [`${days} ${days === 1 ? "day" : "days"}`, hours > 0 ? `${hours} hr` : null]
      : [hours > 0 ? `${hours} hr` : null, minutes > 0 ? `${minutes} min` : null];
  return `${parts.filter((part) => part !== null).join(" ")} left`;
}
