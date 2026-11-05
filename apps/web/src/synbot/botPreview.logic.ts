// FILE: botPreview.logic.ts
// Purpose: What a bot's sidebar row says under its name (HoloBot's botRow): the last word of its
//          thread when the thread is loaded (no check-in, SILENT reply or report wake-up), and
//          when it was said, in the list's short form ("19:08" today, "Mon" this week, "26 Oct").
// Layer: Web domain logic (pure)
// Exports: BotPreview, latestBotPreview, listTime

import { BOT_REPORT_MESSAGE_PREFIX, type ThreadId } from "@synara/contracts";
import {
  isCoordinatorCheckinUserMessage,
  isSilentCoordinatorCheckinReply,
} from "@synara/shared/coordinatorCheckin";

import type { AppState } from "../storeState";

export interface BotPreview {
  readonly text: string;
  readonly at: string;
}

const PREVIEW_MAX = 140;

/** The newest message worth showing in `threadId`, or null when none is loaded. */
export function latestBotPreview(state: AppState, threadId: ThreadId): BotPreview | null {
  const ids = state.messageIdsByThreadId?.[threadId];
  const byId = state.messageByThreadId?.[threadId];
  if (!ids || !byId) return null;
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const message = byId[ids[index]!];
    if (!message || message.role === "system") continue;
    if (message.id.startsWith(BOT_REPORT_MESSAGE_PREFIX)) continue;
    if (isCoordinatorCheckinUserMessage(message)) continue;
    if (message.role === "assistant" && isSilentCoordinatorCheckinReply(message.text)) continue;
    const text = message.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    return { text: text.slice(0, PREVIEW_MAX), at: message.createdAt };
  }
  return null;
}

const DAY_MS = 86_400_000;

const midnight = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "19:08" on the day of `now`, else the weekday within a week, else "26 Oct". */
export function listTime(
  iso: string,
  now: number,
  locale: string | undefined,
  hour12: boolean | undefined,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((midnight(new Date(now)) - midnight(date)) / DAY_MS);
  if (days <= 0) {
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      ...(hour12 === undefined ? {} : { hour12 }),
    }).format(date);
  }
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
}
