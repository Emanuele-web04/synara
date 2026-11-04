// FILE: threadSnooze.ts
// Purpose: Shared snooze deadlines, labels, and the metadata command used by the
//          sidebar and the in-chat snooze notice.
// Layer: Web UI utility
// Exports: SNOOZE_PRESETS, resolveSnoozeDeadline, formatSnoozeDeadline,
//          toDateTimeLocalValue, parseFutureDateTimeLocalValue, dispatchThreadSnoozedUntil

import type { ThreadId } from "@synara/contracts";
import { getFormatLocale, t } from "~/i18n";

import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "./utils";

export type SnoozeDuration = 30 | 60 | 120 | "tomorrow" | Date;

export const SNOOZE_PRESETS = [
  { id: "snooze-30", label: "For 30 minutes", labelKey: "common:for30Minutes", duration: 30 },
  { id: "snooze-60", label: "For 1 hour", labelKey: "common:for1Hour", duration: 60 },
  { id: "snooze-120", label: "For 2 hours", labelKey: "common:for2Hours", duration: 120 },
  {
    id: "snooze-tomorrow",
    label: "Until tomorrow at 9am",
    labelKey: "common:untilTomorrowAt9am",
    duration: "tomorrow",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  labelKey: string;
  duration: SnoozeDuration;
}>;

/** Minute presets are elapsed time; "tomorrow" is 9am in the user's local calendar. */
export function resolveSnoozeDeadline(duration: SnoozeDuration, nowMs: number): Date {
  if (duration instanceof Date) return new Date(duration.getTime());
  const deadline = new Date(nowMs);
  if (duration === "tomorrow") {
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(9, 0, 0, 0);
  } else {
    deadline.setTime(nowMs + duration * 60_000);
  }
  return deadline;
}

export function formatSnoozeDeadline(snoozedUntil: string, locale = getFormatLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(snoozedUntil));
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `<input type="datetime-local">` value for a local wall-clock time. */
export function toDateTimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Parses a datetime-local value; null unless it is a valid time in the future. */
export function parseFutureDateTimeLocalValue(value: string, nowMs: number): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getTime() <= nowMs ? null : date;
}

/**
 * Schedules (or with null, cancels) a snooze. Resolves false after showing an
 * error toast; the projection stays the source of truth for visibility.
 */
export function dispatchThreadSnoozedUntil(
  threadId: ThreadId,
  snoozedUntil: string | null,
): Promise<boolean> {
  const api = readNativeApi();
  if (!api) {
    toastManager.add({ type: "error", title: t("workspace:unableToConnectToTheAppServer") });
    return Promise.resolve(false);
  }
  return api.orchestration
    .dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      snoozedUntil,
    })
    .then(
      () => true,
      () => {
        toastManager.add({
          type: "error",
          title: t(
            snoozedUntil === null ? "common:unableToReturnThread" : "common:unableToSnoozeThread",
          ),
        });
        return false;
      },
    );
}
