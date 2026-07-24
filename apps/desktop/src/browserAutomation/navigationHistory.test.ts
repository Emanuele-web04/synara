import { EventEmitter } from "node:events";

import { ThreadId, type BrowserBackInput } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { navigateBrowserHistory } from "./navigationHistory";

const THREAD_ID = ThreadId.makeUnsafe("thread-history");
const TAB_ID = "73130cae-e4dd-45ea-a157-156912bc0afd";

const createRuntime = (
  currentIndex = 1,
  options: { readonly staleRequestBeforeReload?: boolean } = {},
) => {
  let url = "https://example.test/two";
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getNavigationHistory") {
      return {
        currentIndex,
        entries: [
          { id: 10, url: "https://example.test/one" },
          { id: 11, url: "https://example.test/two" },
          { id: 12, url: "https://example.test/three" },
        ],
      };
    }
    if (method === "Page.navigateToHistoryEntry") {
      url = params?.entryId === 10 ? "https://example.test/one" : "https://example.test/three";
      queueMicrotask(() => {
        debuggerEvents.emit("message", {}, "Page.frameNavigated", {
          frame: { id: "main-frame", loaderId: "loader-history", url },
        });
        debuggerEvents.emit("message", {}, "Page.lifecycleEvent", {
          frameId: "main-frame",
          loaderId: "loader-history",
          name: "DOMContentLoaded",
        });
        debuggerEvents.emit("message", {}, "Page.lifecycleEvent", {
          frameId: "main-frame",
          loaderId: "loader-history",
          name: "load",
        });
      });
      return {};
    }
    if (method === "Page.reload") {
      throw new Error("Electron Page.reload must not be used for the visible WebView");
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame", url } } };
    }
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 1_024, clientHeight: 768 } };
    }
    if (method === "Runtime.evaluate") {
      return {
        result: { value: { url, title: "Example", readyState: "complete", deviceScaleFactor: 1 } },
      };
    }
    return {};
  });
  const emitReload = () => {
    if (options.staleRequestBeforeReload) {
      debuggerEvents.emit("message", {}, "Network.requestWillBeSent", {
        requestId: "stale-request",
        frameId: "main-frame",
        loaderId: "previous-loader",
        type: "Fetch",
        request: { url: "https://example.test/stale" },
      });
    }
    queueMicrotask(() => {
      debuggerEvents.emit("message", {}, "Page.frameNavigated", {
        frame: { id: "main-frame", loaderId: "loader-reload", url },
      });
      debuggerEvents.emit("message", {}, "Page.lifecycleEvent", {
        frameId: "main-frame",
        loaderId: "loader-reload",
        name: "DOMContentLoaded",
      });
      debuggerEvents.emit("message", {}, "Page.lifecycleEvent", {
        frameId: "main-frame",
        loaderId: "loader-reload",
        name: "load",
      });
    });
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => url,
    reload: vi.fn(emitReload),
    reloadIgnoringCache: vi.fn(emitReload),
    once: vi.fn(),
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand,
      on: debuggerEvents.on.bind(debuggerEvents),
      removeListener: debuggerEvents.removeListener.bind(debuggerEvents),
    },
  } as unknown as WebContents;
  return {
    runtime: {
      threadId: THREAD_ID,
      tabId: TAB_ID,
      webContents,
    } satisfies BrowserAutomationVisibleRuntime,
    sendCommand,
  };
};

describe("browser navigation history", () => {
  it("moves through the exact tab history and reports the observed page", async () => {
    const { runtime, sendCommand } = createRuntime();

    await expect(
      navigateBrowserHistory(runtime, "back", {
        waitUntil: "domcontentloaded",
      }),
    ).resolves.toMatchObject({
      tabId: TAB_ID,
      finalUrl: "https://example.test/one",
      loadState: "load",
    });
    expect(sendCommand).toHaveBeenCalledWith("Page.navigateToHistoryEntry", { entryId: 10 });
  });

  it("reloads the exact visible guest with explicit cache policy and observes it through CDP", async () => {
    const { runtime, sendCommand } = createRuntime();

    await navigateBrowserHistory(runtime, "reload", {
      waitUntil: "load",
      ignoreCache: true,
    });

    expect(runtime.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(sendCommand).not.toHaveBeenCalledWith("Page.reload", expect.anything());
  });

  it("does not let an unfinished previous-loader request block reload networkidle", async () => {
    const { runtime } = createRuntime(1, { staleRequestBeforeReload: true });

    await expect(
      navigateBrowserHistory(runtime, "reload", {
        waitUntil: "networkidle",
        timeoutMs: 1_000 as NonNullable<BrowserBackInput["timeoutMs"]>,
      }),
    ).resolves.toMatchObject({
      finalUrl: "https://example.test/two",
      loadState: "networkidle",
    });
  });

  it("fails cleanly before committing when no requested history entry exists", async () => {
    const { runtime } = createRuntime(0);

    await expect(
      navigateBrowserHistory(runtime, "back", {
        waitUntil: "commit",
      }),
    ).rejects.toMatchObject({
      browserError: {
        code: "BrowserNavigationFailed",
        effectMayHaveCommitted: false,
      },
    });
  });

  it("drains Page.stopLoading before releasing an aborted history navigation", async () => {
    const { runtime, sendCommand } = createRuntime();
    const original = sendCommand.getMockImplementation()!;
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    sendCommand.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === "Page.navigateToHistoryEntry") return Promise.resolve({});
      if (method === "Page.stopLoading") return stopped.then(() => ({}));
      return original(method, params);
    });
    const controller = new AbortController();
    const navigation = navigateBrowserHistory(
      runtime,
      "back",
      {
        waitUntil: "load",
        timeoutMs: 1_000 as NonNullable<BrowserBackInput["timeoutMs"]>,
      },
      controller.signal,
    );

    await vi.waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith("Page.navigateToHistoryEntry", { entryId: 10 }),
    );
    controller.abort(new Error("turn stopped"));
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith("Page.stopLoading"));
    let settled = false;
    void navigation
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    releaseStop();
    await expect(navigation).rejects.toThrow("turn stopped");
  });
});
