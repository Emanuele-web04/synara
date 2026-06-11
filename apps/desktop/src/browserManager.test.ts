import type { ThreadBrowserState, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DesktopBrowserManager imports electron at module load. With no window attached
// (setWindow is never called), every method below stays on the in-memory thread/tab
// state model and never reaches the mocked electron surface. These tests pin that
// state-machine so a future extraction of the stateful core can be gated for safety.
vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  clipboard: { writeText: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn() },
}));

import { DesktopBrowserManager } from "./browserManager";

const THREAD = "thread-1" as ThreadId;
const OTHER = "thread-2" as ThreadId;

describe("DesktopBrowserManager state machine (no window attached)", () => {
  let manager: DesktopBrowserManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new DesktopBrowserManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("open() creates a workspace with one active tab and marks the thread open", () => {
    const state = manager.open({ threadId: THREAD, initialUrl: "https://example.com" });

    expect(state.open).toBe(true);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
    expect(state.tabs[0]?.url).toContain("example.com");
  });

  it("newTab() appends and activates by default, and suspends the new tab off-screen", () => {
    manager.open({ threadId: THREAD });
    const firstTabId = manager.getState({ threadId: THREAD }).activeTabId;

    const state = manager.newTab({ threadId: THREAD, url: "https://b.com" });

    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).not.toBe(firstTabId);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
    // No active window/runtime, so the freshly created tab is parked as suspended.
    expect(state.tabs[1]?.status).toBe("suspended");
  });

  it("newTab({ activate: false }) keeps the prior active tab", () => {
    manager.open({ threadId: THREAD });
    const firstTabId = manager.getState({ threadId: THREAD }).activeTabId;

    const state = manager.newTab({ threadId: THREAD, activate: false });

    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(firstTabId);
  });

  it("selectTab() switches the active tab", () => {
    manager.open({ threadId: THREAD });
    const stateAfterNew = manager.newTab({ threadId: THREAD, activate: false });
    const secondTabId = stateAfterNew.tabs[1]?.id as string;

    const state = manager.selectTab({ threadId: THREAD, tabId: secondTabId });

    expect(state.activeTabId).toBe(secondTabId);
  });

  it("closeTab() removes a tab and reassigns the active tab to the last remaining one", () => {
    manager.open({ threadId: THREAD });
    const withSecond = manager.newTab({ threadId: THREAD, activate: false });
    const firstTabId = withSecond.tabs[0]?.id as string;
    const secondTabId = withSecond.tabs[1]?.id as string;

    const state = manager.closeTab({ threadId: THREAD, tabId: secondTabId });

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.id).toBe(firstTabId);
    expect(state.activeTabId).toBe(firstTabId);
  });

  it("closeTab() on the last tab closes the thread", () => {
    manager.open({ threadId: THREAD });
    const onlyTabId = manager.getState({ threadId: THREAD }).activeTabId as string;

    const state = manager.closeTab({ threadId: THREAD, tabId: onlyTabId });

    expect(state.open).toBe(false);
    expect(state.tabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
  });

  it("close() resets tabs and active state but keeps the thread entry", () => {
    manager.open({ threadId: THREAD });

    const state = manager.close({ threadId: THREAD });

    expect(state.open).toBe(false);
    expect(state.tabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it("navigate() updates the active tab's url and a default title", () => {
    manager.open({ threadId: THREAD });

    const state = manager.navigate({ threadId: THREAD, url: "https://navigated.dev/path" });

    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    expect(active?.url).toContain("navigated.dev");
    expect(active?.title).toBeTruthy();
    expect(active?.lastError).toBeNull();
  });

  it("bumps version and invalidates the snapshot cache only on real changes", () => {
    const opened = manager.open({ threadId: THREAD });
    const versionAfterOpen = opened.version;

    // getState is a pure read: same version returns the cached snapshot instance.
    const readA = manager.getState({ threadId: THREAD });
    const readB = manager.getState({ threadId: THREAD });
    expect(readB.version).toBe(versionAfterOpen);
    expect(readB).toBe(readA);

    const navigated = manager.navigate({ threadId: THREAD, url: "https://changed.dev" });
    expect(navigated.version).toBeGreaterThan(versionAfterOpen);
    expect(navigated).not.toBe(readA);
  });

  it("notifies subscribers on state changes and stops after unsubscribe", () => {
    const events: ThreadBrowserState[] = [];
    const unsubscribe = manager.subscribe((snapshot) => events.push(snapshot));

    manager.open({ threadId: THREAD });
    const countAfterOpen = events.length;
    expect(countAfterOpen).toBeGreaterThan(0);

    unsubscribe();
    manager.navigate({ threadId: THREAD, url: "https://after-unsub.dev" });
    expect(events.length).toBe(countAfterOpen);
  });

  it("keeps thread state isolated across thread ids", () => {
    manager.open({ threadId: THREAD, initialUrl: "https://one.dev" });
    manager.open({ threadId: OTHER, initialUrl: "https://two.dev" });

    const one = manager.getState({ threadId: THREAD });
    const two = manager.getState({ threadId: OTHER });

    expect(one.tabs[0]?.url).toContain("one.dev");
    expect(two.tabs[0]?.url).toContain("two.dev");
    expect(one.tabs[0]?.id).not.toBe(two.tabs[0]?.id);
  });

  it("dispose() clears pending suspend timers without throwing", () => {
    manager.open({ threadId: THREAD });
    manager.hide({ threadId: THREAD });

    expect(() => manager.dispose()).not.toThrow();
    // Advancing timers must not fire callbacks against disposed state.
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
  });

  it("getPerformanceSnapshot() reports counters and no tracked process ids", () => {
    manager.open({ threadId: THREAD });
    manager.navigate({ threadId: THREAD, url: "https://perf.dev" });

    const snapshot = manager.getPerformanceSnapshot();

    expect(snapshot.trackedProcessIds).toEqual([]);
    expect(snapshot.counters.stateEmitCalls).toBeGreaterThan(0);
  });
});
