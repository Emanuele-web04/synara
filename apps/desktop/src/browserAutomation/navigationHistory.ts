import type {
  BrowserBackInput,
  BrowserNavigateOutput,
  BrowserReloadInput,
  BrowserTabId,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { abortReason, sendCdpCommand, throwIfAborted } from "./cdpRuntime";
import { browserHostError } from "./hostErrors";
import { getBrowserNavigationTracker, stopBrowserNavigation } from "./navigationTracker";
import { waitForLoadMilestone } from "./waitAndEvaluate";

export type BrowserHistoryDirection = "back" | "forward" | "reload";

interface NavigationHistoryEntry {
  readonly id?: number;
  readonly url?: string;
}

interface NavigationHistoryResponse {
  readonly currentIndex?: number;
  readonly entries?: readonly NavigationHistoryEntry[];
}

const validateObservedWebUrl = (
  runtime: BrowserAutomationVisibleRuntime,
  value: string,
): string => {
  if (value === "about:blank") return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    return url.href;
  } catch {
    browserHostError({
      code: "BrowserNavigationBlocked",
      retryable: false,
      phase: "navigation",
      effectMayHaveCommitted: true,
      tabId: runtime.tabId as BrowserTabId,
    });
  }
};

function missingHistoryEntry(runtime: BrowserAutomationVisibleRuntime): never {
  return browserHostError({
    code: "BrowserNavigationFailed",
    retryable: false,
    phase: "navigation",
    effectMayHaveCommitted: false,
    tabId: runtime.tabId as BrowserTabId,
  });
}

/**
 * Drive the exact renderer tab's Chromium history. The host keeps this call
 * under the same per-tab lock and human-control guard as all other actions.
 */
export const navigateBrowserHistory = async (
  runtime: BrowserAutomationVisibleRuntime,
  direction: BrowserHistoryDirection,
  input: BrowserBackInput | BrowserReloadInput,
  signal?: AbortSignal,
): Promise<BrowserNavigateOutput> => {
  throwIfAborted(signal);
  const tracker = await getBrowserNavigationTracker(runtime, signal);
  const mark = tracker.mark();
  if (direction === "reload") {
    // Electron acknowledges CDP Page.reload on an embedded <webview> without
    // reliably initiating a navigation. Drive the exact adopted guest through
    // WebContents instead; the shared CDP tracker below remains the source of
    // truth for commit/load/network-idle confirmation and redirect metadata.
    if ("ignoreCache" in input && input.ignoreCache) runtime.webContents.reloadIgnoringCache();
    else runtime.webContents.reload();
  } else {
    const history = await sendCdpCommand<NavigationHistoryResponse>(
      runtime,
      "Page.getNavigationHistory",
      {},
      signal,
    );
    const currentIndex = history.currentIndex;
    const entries = history.entries;
    if (typeof currentIndex !== "number" || !Number.isSafeInteger(currentIndex) || !entries) {
      missingHistoryEntry(runtime);
    }
    const targetIndex = direction === "back" ? currentIndex - 1 : currentIndex + 1;
    const entry = entries[targetIndex];
    if (!entry || typeof entry.id !== "number" || !Number.isSafeInteger(entry.id)) {
      missingHistoryEntry(runtime);
    }
    await sendCdpCommand(runtime, "Page.navigateToHistoryEntry", { entryId: entry.id }, signal, {
      effectMayHaveCommitted: true,
      onAbort: () => stopBrowserNavigation(runtime),
    });
  }
  throwIfAborted(signal);
  let loaded;
  try {
    loaded = await waitForLoadMilestone(
      runtime,
      input.waitUntil ?? "domcontentloaded",
      input.timeoutMs ?? 15_000,
      signal,
      mark,
    );
  } catch (error) {
    if (signal?.aborted) {
      await stopBrowserNavigation(runtime);
      throw abortReason(signal);
    }
    throw error;
  }
  return {
    tabId: runtime.tabId as BrowserTabId,
    finalUrl: validateObservedWebUrl(runtime, loaded.url),
    redirects: [...loaded.redirects],
    loadState: loaded.state,
  };
};
