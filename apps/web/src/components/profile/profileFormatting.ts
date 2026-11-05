// FILE: profileFormatting.ts
// Purpose: Apply the web app's active locale to the shared, public-profile-safe formatters.
// Layer: web profile presentation; shared numeric/date behavior stays in profile-ui.

import {
  formatCompact as compact,
  formatHourLabel as hourLabel,
  formatNumber as number,
  formatShortDate as shortDate,
} from "@synara/profile-ui/formatting";
import { getFormatLocale, t } from "~/i18n";

export {
  deriveInitials,
  formatProviderLabel,
  normalizeHandle,
  toDisplayName,
} from "@synara/profile-ui/formatting";

export function formatCompact(
  value: number | null | undefined,
  locale = getFormatLocale(),
): string {
  return compact(value, locale);
}

export function formatNumber(value: number | null | undefined, locale = getFormatLocale()): string {
  return number(value, locale);
}

export function formatShortDate(day: string | null, locale = getFormatLocale()): string | null {
  return shortDate(day, locale);
}

export function formatHourLabel(hour: number, locale = getFormatLocale()): string {
  return hourLabel(hour, locale);
}

// Day words follow the UI language while callers may choose a regional number format.
export function formatDays(value: number, locale = getFormatLocale()): string {
  return t(value === 1 ? "common:day" : "common:days", {
    amount: number(value, locale),
    count: value,
  });
}

export function formatProfileUsageBasis(
  metric: "tokens" | "turns",
  _locale = getFormatLocale(),
): string {
  return t(metric === "tokens" ? "common:trackedTokens" : "common:turns");
}
