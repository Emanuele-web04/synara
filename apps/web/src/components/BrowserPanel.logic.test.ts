import { describe, expect, it, vi } from "vitest";

import {
  browserAddressDisplayValue,
  buildBrowserAddressSuggestions,
  createBrowserPanelHideScheduler,
  createBrowserRendererLossHandler,
  normalizeBrowserAddressInput,
  resolveBrowserChromeStatus,
  resolveBrowserAddressSync,
} from "./BrowserPanel.logic";

describe("createBrowserRendererLossHandler", () => {
  it("recovers the same logical tab on the next renderer generation exactly once", () => {
    const oldRenderer = { webContentsId: 17 };
    let currentRenderer = oldRenderer;
    const detach = vi.fn();
    const recover = vi.fn((recovery: { tabId: string; generation: number }) => {
      currentRenderer = { webContentsId: 18 };
      return recovery;
    });
    const onRendererLoss = createBrowserRendererLossHandler({
      renderer: oldRenderer,
      rendererGeneration: 4,
      tabId: "tab-a",
      isCurrent: (renderer) => currentRenderer === renderer,
      detach,
      recover,
    });

    // Electron can surface both `render-process-gone` and `destroyed` for the
    // same physical guest. Both events share this one-shot handler.
    onRendererLoss();
    onRendererLoss();

    expect(detach).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledWith(oldRenderer);
    expect(recover).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith({ tabId: "tab-a", generation: 5 });
    expect(currentRenderer.webContentsId).toBe(18);
    expect(currentRenderer.webContentsId).not.toBe(oldRenderer.webContentsId);
  });

  it("cannot let a stale renderer-loss handler evict its replacement", () => {
    const oldRenderer = { webContentsId: 17 };
    const currentRenderer = { webContentsId: 18 };
    const detach = vi.fn();
    const recover = vi.fn();
    const onRendererLoss = createBrowserRendererLossHandler({
      renderer: oldRenderer,
      rendererGeneration: 4,
      tabId: "tab-a",
      isCurrent: (renderer) => currentRenderer === renderer,
      detach,
      recover,
    });

    onRendererLoss();

    expect(detach).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });
});

describe("createBrowserPanelHideScheduler", () => {
  it("cancels a passive StrictMode cleanup when the same panel remounts", () => {
    vi.useFakeTimers();
    try {
      const hide = vi.fn();
      const scheduler = createBrowserPanelHideScheduler();

      scheduler.schedule("thread-a", hide);
      scheduler.cancel("thread-a");
      vi.runAllTimers();

      expect(hide).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still hides after a real unmount without a matching remount", () => {
    vi.useFakeTimers();
    try {
      const hide = vi.fn();
      const scheduler = createBrowserPanelHideScheduler();

      scheduler.schedule("thread-a", hide);
      vi.runAllTimers();

      expect(hide).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browserAddressDisplayValue", () => {
  it("hides about:blank for new tabs", () => {
    expect(browserAddressDisplayValue({ url: "about:blank" })).toBe("");
  });

  it("keeps real urls visible", () => {
    expect(browserAddressDisplayValue({ url: "https://x.com/" })).toBe("https://x.com/");
  });
});

describe("resolveBrowserAddressSync", () => {
  it("restores a saved draft when switching to another tab", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-1",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "x.com",
      syncedValue: "",
    });
  });

  it("keeps the typed value while the active tab is still being edited", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "",
        lastSyncedValue: "",
        isEditing: true,
      }),
    ).toEqual({
      type: "keep",
    });
  });

  it("updates the input when a submitted navigation resolves to a new url", () => {
    expect(
      resolveBrowserAddressSync({
        activeTabId: "tab-2",
        previousActiveTabId: "tab-2",
        savedDraft: "x.com",
        nextDisplayValue: "https://x.com/",
        lastSyncedValue: "",
        isEditing: false,
      }),
    ).toEqual({
      type: "replace",
      value: "https://x.com/",
      syncedValue: "https://x.com/",
    });
  });
});

describe("normalizeBrowserAddressInput", () => {
  it("adds https to naked domains", () => {
    expect(normalizeBrowserAddressInput("phodex.app")).toBe("https://phodex.app/");
  });

  it("turns spaced text into a search url", () => {
    expect(normalizeBrowserAddressInput("how to bake bread")).toContain(
      "https://www.google.com/search?q=how%20to%20bake%20bread",
    );
  });
});

describe("buildBrowserAddressSuggestions", () => {
  it("hides blank tabs and surfaces direct navigation", () => {
    const suggestions = buildBrowserAddressSuggestions({
      query: "open",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          title: "New tab",
          url: "about:blank",
          faviconUrl: null,
          lastCommittedUrl: null,
        },
        {
          id: "tab-2",
          title: "OpenAI",
          url: "https://openai.com/",
          faviconUrl: null,
          lastCommittedUrl: "https://openai.com/",
        },
      ],
      recentHistory: [
        {
          url: "about:blank",
          title: "Blank",
          tabId: "tab-1",
        },
        {
          url: "https://news.ycombinator.com/",
          title: "Hacker News",
          tabId: "tab-3",
        },
      ],
    });

    expect(suggestions[0]).toMatchObject({
      kind: "navigate",
      url: "https://www.google.com/search?q=open",
    });
    expect(suggestions.some((suggestion) => suggestion.url === "about:blank")).toBe(false);
    expect(suggestions.some((suggestion) => suggestion.url === "https://openai.com/")).toBe(true);
  });
});

describe("resolveBrowserChromeStatus", () => {
  it("surfaces recoverable browser errors ahead of idle state", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: "Couldn't complete that browser action.",
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toEqual({
      tone: "error",
      label: "Couldn't complete that browser action.",
    });
  });

  it("does not duplicate the current url when a page is loaded", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "ready",
        hasActiveTab: true,
        workspaceReady: true,
      }),
    ).toBeNull();
  });

  it("keeps onboarding copy for empty browser states", () => {
    expect(
      resolveBrowserChromeStatus({
        localError: null,
        threadLastError: null,
        activeTabStatus: "suspended",
        hasActiveTab: false,
        workspaceReady: false,
      }),
    ).toEqual({
      tone: "default",
      label: "Starting browser...",
    });
  });
});
