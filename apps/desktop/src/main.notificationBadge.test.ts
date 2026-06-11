// FILE: main.notificationBadge.test.ts
// Purpose: Lock the unread badge count, clamping, and foreground detection behavior.

import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import { isMainWindowForeground, NotificationBadgeState } from "./main.notificationBadge";

function fakeWindow(overrides: Partial<Record<"visible" | "minimized" | "focused", boolean>> = {}) {
  const state = { visible: true, minimized: false, focused: true, ...overrides };
  return {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
  } as unknown as BrowserWindow;
}

describe("isMainWindowForeground", () => {
  it("returns false when there is no window", () => {
    expect(isMainWindowForeground(null)).toBe(false);
  });

  it("requires visible, not-minimized, and focused", () => {
    expect(isMainWindowForeground(fakeWindow())).toBe(true);
    expect(isMainWindowForeground(fakeWindow({ visible: false }))).toBe(false);
    expect(isMainWindowForeground(fakeWindow({ minimized: true }))).toBe(false);
    expect(isMainWindowForeground(fakeWindow({ focused: false }))).toBe(false);
  });
});

describe("NotificationBadgeState", () => {
  function setup(window: BrowserWindow | null = null) {
    const setBadgeCount = vi.fn<(count: number) => void>();
    const badge = new NotificationBadgeState({ setBadgeCount, getWindow: () => window });
    return { badge, setBadgeCount };
  }

  it("increments and mirrors the count onto the badge", () => {
    const { badge, setBadgeCount } = setup();
    badge.increment();
    badge.increment();
    expect(badge.getCount()).toBe(2);
    expect(setBadgeCount).toHaveBeenLastCalledWith(2);
  });

  it("clamps the count at 99", () => {
    const { badge, setBadgeCount } = setup();
    for (let i = 0; i < 105; i += 1) {
      badge.increment();
    }
    expect(badge.getCount()).toBe(99);
    expect(setBadgeCount).toHaveBeenLastCalledWith(99);
  });

  it("clear resets to zero and only syncs when there is something to clear", () => {
    const { badge, setBadgeCount } = setup();
    badge.clear();
    expect(setBadgeCount).not.toHaveBeenCalled();

    badge.increment();
    setBadgeCount.mockClear();
    badge.clear();
    expect(badge.getCount()).toBe(0);
    expect(setBadgeCount).toHaveBeenCalledWith(0);
  });

  it("delegates foreground detection to the supplied window", () => {
    const focused = setup(fakeWindow({ focused: true }));
    expect(focused.badge.isMainWindowForeground()).toBe(true);

    const blurred = setup(fakeWindow({ focused: false }));
    expect(blurred.badge.isMainWindowForeground()).toBe(false);
  });
});
