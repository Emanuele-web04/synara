// FILE: SnoozeCountdown.tsx
// Purpose: Live "Returns <time> · 28 min left" label for a snoozed chat.
// Layer: Shared UI component
// Exports: SnoozeCountdown

import { useNowMs } from "../hooks/useNowMs";
import { formatSnoozeRemainingTime } from "../lib/relativeTime";
import { formatSnoozeDeadline } from "../lib/threadSnooze";
import { useTranslation } from "~/i18n";

/** Ticks on its own so the surrounding row or notice does not re-render every interval. */
export function SnoozeCountdown({ snoozedUntil }: { snoozedUntil: string }) {
  const { t, formatLocale } = useTranslation();

  const nowMs = useNowMs(true, 15_000);
  return (
    <>
      {t("Returns")} {formatSnoozeDeadline(snoozedUntil, formatLocale)} ·{" "}
      {formatSnoozeRemainingTime(snoozedUntil, nowMs, formatLocale)}
    </>
  );
}
