// FILE: browserManager.types.ts
// Purpose: Shared types and constants for the desktop in-app browser runtime.
// Layer: Desktop runtime manager (support)
// Exports: browser runtime constants, runtime/sync interfaces, snapshot/event types

import type { WebContents } from "electron";
import type {
  BrowserCopyLinkEvent,
  BrowserPanelBounds,
  BrowserTabState,
  ThreadBrowserState,
  ThreadId,
} from "@t3tools/contracts";

export const ABOUT_BLANK_URL = "about:blank";
export const BROWSER_SESSION_PARTITION = "persist:synara-browser";
export const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS = 1_500;
export const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS = 400;
export const BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD = 1;
export const BROWSER_THREAD_SUSPEND_DELAY_MS = 30_000;
export const BROWSER_ERROR_ABORTED = -3;
export const SEARCH_URL_PREFIX = "https://www.google.com/search?q=";

export const LIVE_TAB_STATUS: BrowserTabState["status"] = "live";
export const SUSPENDED_TAB_STATUS: BrowserTabState["status"] = "suspended";

export type BrowserStateListener = (state: ThreadBrowserState) => void;
export type BrowserCopyLinkListener = (event: BrowserCopyLinkEvent) => void;

export interface LiveTabRuntime {
  key: string;
  threadId: ThreadId;
  tabId: string;
  webContents: WebContents;
  view: import("electron").WebContentsView | null;
  ownsWebContents: boolean;
  listenerDisposers: Array<() => void>;
}

export interface NativeBrowserViewVisibility {
  setVisible?: (visible: boolean) => void;
}

export interface PendingRuntimeSync {
  threadId: ThreadId;
  tabId: string;
  faviconUrls?: string[];
}

export interface BrowserPerformanceSnapshot {
  counters: {
    setPanelBoundsCalls: number;
    setPanelBoundsNoopSkips: number;
    setPanelBoundsViewportUpdates: number;
    stateEmitCalls: number;
    stateEmitSkips: number;
    stateCloneCount: number;
    runtimeSyncQueueFlushes: number;
    syncRuntimeStateCalls: number;
    inactiveTabSuspendScheduled: number;
    inactiveTabSuspendCancelled: number;
    inactiveTabBudgetEvictions: number;
    warmInactiveRuntimeCount: number;
  };
  trackedProcessIds: number[];
}

export interface BrowserUseSnapshot {
  threadId: ThreadId;
  state: ThreadBrowserState;
}

export interface BrowserUseCdpEvent {
  method: string;
  params?: unknown;
}

export type { BrowserPanelBounds };
