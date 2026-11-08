// FILE: appBadge.ts
// Purpose: The Dock badge's number: unread background notifications plus the items the
//          renderer reports as waiting on the user (SynBot's bots that need the user, Beta only).
// Layer: Desktop main-process helper
// Exports: MAX_APP_BADGE_COUNT, parseAttentionBadgeCount, resolveAppBadgeCount

export const MAX_APP_BADGE_COUNT = 99;

/** A count reported over IPC: a whole number from 0 to the badge's ceiling, anything else 0. */
export function parseAttentionBadgeCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(Math.max(0, Math.floor(raw)), MAX_APP_BADGE_COUNT);
}

/** One badge for both sources, capped like the notification count. */
export function resolveAppBadgeCount(unreadNotifications: number, attention: number): number {
  return Math.min(unreadNotifications + attention, MAX_APP_BADGE_COUNT);
}
