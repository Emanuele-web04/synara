// FILE: relativeTime.ts
// Purpose: Compact relative-time labels ("now", "5m", "3h", "2d", "1w", "5mo") for thread and
//          pull request lists, plus the snooze countdown label.
// Layer: Web UI utility
import { getFormatLocale, i18n, t } from "~/i18n";

export function formatRelativeTime(
  iso: string,
  nowMs = Date.now(),
  locale = getFormatLocale(),
): string {
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("chat:relativeTime_now");
  if (minutes < 60) return relativeAmount(minutes, "minute", "m", locale);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relativeAmount(hours, "hour", "h", locale);
  const days = Math.floor(hours / 24);
  if (days < 7) return relativeAmount(days, "day", "d", locale);
  if (days < 30) return relativeAmount(Math.floor(days / 7), "week", "w", locale);
  if (days < 365) return relativeAmount(Math.floor(days / 30), "month", "mo", locale);
  return relativeAmount(Math.floor(days / 365), "year", "y", locale);
}

/** A complete phrase for surfaces that previously appended "ago" to compact English time. */
export function formatRelativeTimeAgo(
  iso: string,
  nowMs = Date.now(),
  locale = getFormatLocale(),
  translate: typeof t = t,
): string {
  if (Math.max(0, nowMs - new Date(iso).getTime()) < 60_000) return translate("git:justNow");
  const relative = formatRelativeTime(iso, nowMs, locale);
  return i18n.language === "en" ? translate("common:ago2", { value0: relative }) : relative;
}

function relativeAmount(
  amount: number,
  unit: Intl.RelativeTimeFormatUnit,
  englishSuffix: string,
  locale: string | undefined,
): string {
  // Keep the established compact English list labels; Spanish uses its native relative phrases.
  return i18n.language === "en"
    ? `${new Intl.NumberFormat(locale).format(amount)}${englishSuffix}`
    : new Intl.RelativeTimeFormat(locale ?? i18n.language, {
        style: "short",
        numeric: "auto",
      }).format(-amount, unit);
}

/** Countdown label for a snoozed thread ("28 min left", "1 hr 28 min left", "2 days 1 hr left"). */
export function formatSnoozeRemainingTime(
  snoozedUntil: string,
  nowMs: number,
  locale = getFormatLocale(),
): string {
  const remainingMs = Date.parse(snoozedUntil) - nowMs;
  if (!(remainingMs > 0)) return t("common:returning");
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return t("common:lessThanAMinuteLeft");
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts =
    days > 0
      ? [
          t(days === 1 ? "common:day" : "common:days", {
            amount: new Intl.NumberFormat(locale).format(days),
            count: days,
          }),
          hours > 0
            ? t("common:hr", { amount: new Intl.NumberFormat(locale).format(hours) })
            : null,
        ]
      : [
          hours > 0
            ? t("common:hr", { amount: new Intl.NumberFormat(locale).format(hours) })
            : null,
          minutes > 0
            ? t("common:min", { amount: new Intl.NumberFormat(locale).format(minutes) })
            : null,
        ];
  return t("common:left2", { duration: parts.filter((part) => part !== null).join(" ") });
}
