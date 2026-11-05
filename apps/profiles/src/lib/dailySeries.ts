// The trailing N owner-local days of tokens and prompts, zero-filled, for the page's
// Tokens and Prompts charts. Same anchor as the heatmap: the owner's local today (or the
// newest bucket when later), so both read the same days.

import type { PublicProfileHeatmapDay } from "./publicProfile";

const DAY_MS = 86_400_000;

export type DailyPoint = { day: string; tokens: number; prompts: number };

function utcMsOf(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

export function buildDailySeries(
  days: readonly PublicProfileHeatmapDay[],
  windowDays: number,
  localToday?: string,
): DailyPoint[] {
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const now = new Date();
  const todayMs = localToday
    ? utcMsOf(localToday)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const newestMs = days.reduce((max, entry) => Math.max(max, utcMsOf(entry.day)), 0);
  const endMs = Math.max(todayMs, newestMs);

  const points: DailyPoint[] = [];
  for (let index = windowDays - 1; index >= 0; index -= 1) {
    const day = new Date(endMs - index * DAY_MS).toISOString().slice(0, 10);
    const entry = byDay.get(day);
    points.push({ day, tokens: entry?.tokens ?? 0, prompts: entry?.prompts ?? 0 });
  }
  return points;
}

/** Tokens over the heatmap days that fall in `year` (owner-local), for "2.7T tokens in 2026". */
export function tokensInYear(days: readonly PublicProfileHeatmapDay[], year: string): number {
  return days.reduce(
    (sum, entry) => (entry.day.startsWith(`${year}-`) ? sum + entry.tokens : sum),
    0,
  );
}

/** Active days in the window: the denominator behind "active N of the last 30 days". */
export function activeDayCount(points: readonly DailyPoint[]): number {
  return points.filter((point) => point.tokens > 0 || point.prompts > 0).length;
}
