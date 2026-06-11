// FILE: main.notificationBadge.ts
// Purpose: Track the unread off-focus notification count and mirror it onto the app badge.
// Layer: Desktop main process
// Exports: NotificationBadgeState, isMainWindowForeground, NotificationBadgeDeps.

import type { BrowserWindow } from "electron";

const MAX_UNREAD_BADGE_COUNT = 99;

// Count minimized, hidden, or unfocused windows as background notification targets.
export function isMainWindowForeground(window: BrowserWindow | null): boolean {
  if (!window) {
    return false;
  }
  return window.isVisible() && !window.isMinimized() && window.isFocused();
}

export interface NotificationBadgeDeps {
  readonly setBadgeCount: (count: number) => void;
  readonly getWindow: () => BrowserWindow | null;
}

// Keeps the OS app badge aligned with desktop notifications that arrive off-focus.
export class NotificationBadgeState {
  private unreadCount = 0;

  constructor(private readonly deps: NotificationBadgeDeps) {}

  getCount(): number {
    return this.unreadCount;
  }

  isMainWindowForeground(): boolean {
    return isMainWindowForeground(this.deps.getWindow());
  }

  sync(): void {
    this.deps.setBadgeCount(this.unreadCount);
  }

  increment(): void {
    this.unreadCount = Math.min(this.unreadCount + 1, MAX_UNREAD_BADGE_COUNT);
    this.sync();
  }

  clear(): void {
    if (this.unreadCount === 0) {
      return;
    }
    this.unreadCount = 0;
    this.sync();
  }
}
