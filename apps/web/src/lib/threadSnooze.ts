// FILE: threadSnooze.ts
// Purpose: Shared snooze deadlines, labels, and the metadata command used by the
//          sidebar and the in-chat snooze notice.
// Layer: Web UI utility
// Exports: SNOOZE_PRESETS, resolveSnoozeDeadline, formatSnoozeDeadline,
//          toDateTimeLocalValue, parseFutureDateTimeLocalValue, dispatchThreadSnoozedUntil

import type { ThreadId } from "@synara/contracts";

import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "./utils";

export type SnoozeDuration = 30 | 60 | 120 | "tomorrow" | Date;

export const SNOOZE_PRESETS = [
  { id: "snooze-30", label: "For 30 minutes", duration: 30 },
  { id: "snooze-60", label: "For 1 hour", duration: 60 },
  { id: "snooze-120", label: "For 2 hours", duration: 120 },
  { id: "snooze-tomorrow", label: "Until tomorrow at 9am", duration: "tomorrow" },
] as const satisfies ReadonlyArray<{ id: string; label: string; duration: SnoozeDuration }>;

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

const SNOOZE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatSnoozeDeadline(snoozedUntil: string): string {
  return SNOOZE_DATE_FORMAT.format(new Date(snoozedUntil));
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
    toastManager.add({ type: "error", title: "Unable to connect to the app server." });
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
          title: snoozedUntil === null ? "Unable to return thread" : "Unable to snooze thread",
        });
        return false;
      },
    );
}
