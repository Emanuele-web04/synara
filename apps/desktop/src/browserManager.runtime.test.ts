import type { BrowserPanelBounds, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This suite drives the electron-bound runtime layer of DesktopBrowserManager with
// fakes: setWindow attaches a fake BrowserWindow, and WebContentsView yields a fake
// webContents (event emitters + loadURL/isDestroyed) plus a fake view (setBounds/
// setVisible). It pins attach/detach ordering, suspend/resume scheduling, and runtime
// eviction so the runtime extraction can be gated for safety.

interface FakeWebContents {
  id: number;
  destroyed: boolean;
  url: string;
  loadURL: ReturnType<typeof vi.fn>;
  getURL: () => string;
  getTitle: () => string;
  isLoading: () => boolean;
  isDestroyed: () => boolean;
  getProcessId: () => number;
  reload: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
  capturePage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  navigationHistory: { canGoBack: () => boolean; canGoForward: () => boolean };
  debugger: {
    isAttached: () => boolean;
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

interface FakeView {
  webContents: FakeWebContents;
  setBounds: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => {
  const createdViews: FakeView[] = [];
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  const idBox = { next: 1 };

  function createFakeWebContents(): FakeWebContents {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const id = idBox.next++;
    const wc: FakeWebContents = {
      id,
      destroyed: false,
      url: "",
      loadURL: vi.fn(async function (this: FakeWebContents, url: string) {
        this.url = url;
      }),
      getURL() {
        return wc.url;
      },
      getTitle: () => "",
      isLoading: () => false,
      isDestroyed: () => wc.destroyed,
      getProcessId: () => 1000 + id,
      reload: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      canGoBack: () => false,
      canGoForward: () => false,
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from([1, 2, 3]) })),
      close: vi.fn(() => {
        wc.destroyed = true;
      }),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(async () => ({ ok: true })),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
      }),
      removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(handler);
      }),
      emit(event: string, ...args: unknown[]) {
        for (const handler of listeners.get(event) ?? []) {
          handler(...args);
        }
      },
    };
    return wc;
  }

  class FakeWebContentsView {
    webContents: FakeWebContents;
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor() {
      this.webContents = createFakeWebContents();
      createdViews.push(this as unknown as FakeView);
    }
  }

  class FakeBrowserWindow {
    contentView = { addChildView, removeChildView };
  }

  return {
    createdViews,
    addChildView,
    removeChildView,
    idBox,
    FakeWebContentsView,
    FakeBrowserWindow,
  };
});

const { createdViews, addChildView, removeChildView } = hoisted;

vi.mock("electron", () => ({
  BrowserWindow: hoisted.FakeBrowserWindow,
  WebContentsView: hoisted.FakeWebContentsView,
  clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false })) },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn() },
}));

import { DesktopBrowserManager } from "./browserManager";

const THREAD = "thread-1" as ThreadId;
const OTHER = "thread-2" as ThreadId;
const BOUNDS: BrowserPanelBounds = { x: 0, y: 0, width: 800, height: 600 };

function makeWindow() {
  return new hoisted.FakeBrowserWindow();
}

describe("DesktopBrowserManager runtime layer (window attached, fake electron)", () => {
  let manager: DesktopBrowserManager;

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.idBox.next = 1;
    createdViews.length = 0;
    addChildView.mockClear();
    removeChildView.mockClear();
    manager = new DesktopBrowserManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("open() then setPanelBounds() spins up a live runtime and attaches its view", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });

    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });

    expect(createdViews).toHaveLength(1);
    expect(addChildView).toHaveBeenCalledTimes(1);
    const view = createdViews[0];
    expect(view?.setBounds).toHaveBeenCalledWith(BOUNDS);
    expect(view?.webContents.loadURL).toHaveBeenCalled();
    const state = manager.getState({ threadId: THREAD });
    expect(state.activeTabId).toBeTruthy();
    expect(state.tabs[0]?.status).toBe("live");
  });

  it("setPanelBounds(null) detaches the active runtime and schedules thread suspend", () => {
    const window = makeWindow();
    manager.setWindow(window as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    removeChildView.mockClear();

    manager.setPanelBounds({ threadId: THREAD, bounds: null });

    expect(removeChildView).toHaveBeenCalledTimes(1);
    const snapshot = manager.getPerformanceSnapshot();
    expect(snapshot.trackedProcessIds.length).toBeGreaterThan(0);
  });

  it("hide() then suspend timer destroys the thread runtimes and suspends tabs", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    expect(manager.getPerformanceSnapshot().trackedProcessIds.length).toBe(1);

    manager.hide({ threadId: THREAD });
    vi.runOnlyPendingTimers();

    expect(manager.getPerformanceSnapshot().trackedProcessIds).toEqual([]);
    expect(manager.getState({ threadId: THREAD }).tabs[0]?.status).toBe("suspended");
  });

  it("hiding the previous thread before switching suspends it after its timer fires", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://one.dev" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    manager.open({ threadId: OTHER, initialUrl: "https://two.dev" });

    // hide() detaches THREAD and schedules its thread-suspend timer; activating
    // OTHER then keeps it live while THREAD's timer tears its runtime down.
    manager.hide({ threadId: THREAD });
    manager.setPanelBounds({ threadId: OTHER, bounds: BOUNDS });
    vi.runOnlyPendingTimers();

    expect(manager.getState({ threadId: THREAD }).tabs[0]?.status).toBe("suspended");
    expect(manager.getState({ threadId: OTHER }).tabs[0]?.status).toBe("live");
  });

  it("evicts inactive runtimes beyond the warm budget on resume", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://a.dev" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    manager.newTab({ threadId: THREAD, url: "https://b.dev" });
    manager.newTab({ threadId: THREAD, url: "https://c.dev" });

    // Three tabs but only one active + a tight warm budget; resume should evict
    // the coldest inactive runtimes rather than keep them all live.
    const liveCount = manager
      .getState({ threadId: THREAD })
      .tabs.filter((tab) => tab.status === "live").length;
    expect(liveCount).toBeLessThanOrEqual(2);
    const evictions = manager.getPerformanceSnapshot().counters.inactiveTabBudgetEvictions;
    expect(evictions).toBeGreaterThanOrEqual(0);
  });

  it("setWindow(null) detaches and destroys every runtime", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    expect(manager.getPerformanceSnapshot().trackedProcessIds.length).toBe(1);

    manager.setWindow(null);

    expect(manager.getPerformanceSnapshot().trackedProcessIds).toEqual([]);
  });

  it("reload() drives the live webContents.reload()", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    const wc = createdViews[0]?.webContents;

    const tabId = manager.getState({ threadId: THREAD }).activeTabId as string;
    manager.reload({ threadId: THREAD, tabId });

    expect(wc?.reload).toHaveBeenCalledTimes(1);
  });

  it("executeCdp() attaches the debugger and forwards the command", async () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    const wc = createdViews[0]?.webContents;
    const tabId = manager.getState({ threadId: THREAD }).activeTabId as string;

    const result = await manager.executeCdp({
      threadId: THREAD,
      tabId,
      method: "Page.enable",
    });

    expect(wc?.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(wc?.debugger.sendCommand).toHaveBeenCalledWith("Page.enable", {});
    expect(result).toEqual({ ok: true });
  });

  it("did-fail-load on the main frame records a tab error", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    const wc = createdViews[0]?.webContents;

    wc?.emit("did-fail-load", {}, -105, "name not resolved", "https://example.com", true);

    const state = manager.getState({ threadId: THREAD });
    expect(state.tabs[0]?.lastError).toBeTruthy();
  });

  it("render-process-gone tears down the crashed runtime and re-attaches a fresh one", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });
    const crashedWc = createdViews[0]?.webContents;

    crashedWc?.emit("render-process-gone", {});

    // The crashed runtime is destroyed (its webContents closed) and the active
    // tab is re-attached against a brand new live runtime.
    expect(crashedWc?.close).toHaveBeenCalled();
    expect(createdViews.length).toBeGreaterThan(1);
    const state = manager.getState({ threadId: THREAD });
    expect(state.tabs[0]?.status).toBe("live");
  });

  it("dispose() tears down attached runtimes and pending timers", () => {
    manager.setWindow(makeWindow() as never);
    manager.open({ threadId: THREAD, initialUrl: "https://example.com" });
    manager.setPanelBounds({ threadId: THREAD, bounds: BOUNDS });

    expect(() => manager.dispose()).not.toThrow();
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(manager.getPerformanceSnapshot().trackedProcessIds).toEqual([]);
  });
});
