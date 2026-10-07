// What the share images say about a profile: the poster's headline and sentence, the
// receipt's lines, and the trailing month both draw. Pure data so the image route only
// lays it out.

import { formatCompact, formatHourLabel } from "@synara/profile-ui/formatting";
import { buildDailySeries } from "./dailySeries";
import { groupModelUsage } from "./modelUsage";
import { resolveProfileAccent } from "./profileAccent";
import type { PublicProfile } from "./publicProfile";

export const SHARE_FORMATS = ["poster", "story", "card"] as const;
export type ShareFormat = (typeof SHARE_FORMATS)[number];

/** Pixel size of each share image: a 4:5 feed post, a 9:16 story, a link preview. */
export const SHARE_SIZES: Record<ShareFormat, { width: number; height: number }> = {
  poster: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  card: { width: 1200, height: 630 },
};

export function isShareFormat(value: string): value is ShareFormat {
  return (SHARE_FORMATS as readonly string[]).includes(value);
}

/** Days the poster's line and the receipt's barcode span. */
const SHARE_WINDOW_DAYS = 30;
const DEFAULT_ACCENT = "#3b82f6";

export type ShareCardData = {
  accent: string;
  totalTokens: string;
  /** Lifetime tokens written out in full for the receipt's total line. */
  totalTokensExact: string;
  prompts: number;
  activeDays: number;
  currentStreak: number;
  peakDay: string | null;
  topModel: string | null;
  busiestHour: string | null;
  /** Tokens per day over the trailing month, oldest first. */
  month: { day: string; tokens: number }[];
  /** Up to four models, most used first: name, turns, compact tokens, share of the top one. */
  models: { name: string; turns: number; tokens: string; relative: number }[];
  /** Prompts per hour of the owner's day, 0–23. */
  hours: number[];
};

export function shareCardData(profile: PublicProfile): ShareCardData {
  const groups = groupModelUsage(profile.models);
  const topTokens = Math.max(1, groups[0]?.tokens ?? 0);
  const byHour = new Map(profile.hours.map((entry) => [entry.hour, entry.prompts]));
  const hours = Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? 0);
  const maxHour = Math.max(...hours);
  return {
    accent: resolveProfileAccent(profile)?.light ?? DEFAULT_ACCENT,
    totalTokens: formatCompact(profile.lifetimeTokens),
    totalTokensExact: profile.lifetimeTokens.toLocaleString("en-US"),
    prompts: profile.lifetimePrompts,
    activeDays: profile.heatmap.filter((day) => day.tokens > 0).length,
    currentStreak: profile.currentStreakDays,
    peakDay: profile.peakDay ? formatCompact(profile.peakDay.tokens) : null,
    topModel: groups[0]?.displayName ?? null,
    busiestHour: maxHour > 0 ? formatHourLabel(hours.indexOf(maxHour)) : null,
    month: buildDailySeries(profile.heatmap, SHARE_WINDOW_DAYS, profile.localToday).map(
      ({ day, tokens }) => ({ day, tokens }),
    ),
    models: groups.slice(0, 4).map((group) => ({
      name: group.displayName,
      turns: group.turns,
      tokens: formatCompact(group.tokens),
      relative: group.tokens / topTokens,
    })),
    hours,
  };
}

/** The poster's one-line summary, e.g. "33 prompts over 3 days, mostly with GPT-6 Astra." */
export function posterSentence(data: ShareCardData): string {
  const parts = [
    `${data.prompts.toLocaleString("en-US")} ${data.prompts === 1 ? "prompt" : "prompts"} over ${data.activeDays.toLocaleString("en-US")} ${data.activeDays === 1 ? "day" : "days"}`,
  ];
  if (data.topModel) parts.push(`mostly with ${data.topModel}`);
  if (data.busiestHour) parts.push(`usually around ${data.busiestHour}`);
  return `${parts.join(", ")}.`;
}

/** An SVG path through `values` across a width × height box, the peak near the top. */
export function linePath(values: readonly number[], width: number, height: number): string {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${(height - (value / max) * height * 0.92).toFixed(1)}`,
    )
    .join(" ");
}
