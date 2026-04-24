// FILE: browserManager.ts
// Purpose: Owns the desktop in-app browser runtime and maps thread/tab state onto Electron views.
// Layer: Desktop runtime manager
// Depends on: Electron BrowserWindow/WebContentsView, shared browser IPC contracts

import * as Crypto from "node:crypto";

import { BrowserWindow, clipboard, nativeImage, shell, WebContentsView } from "electron";
import type {
  BrowserCaptureScreenshotResult,
  BrowserExecuteCdpInput,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserPanelBounds,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  BrowserTabState,
  BrowserThreadInput,
  ThreadBrowserState,
  ThreadId,
} from "@t3tools/contracts";

const ABOUT_BLANK_URL = "about:blank";
const BROWSER_SESSION_PARTITION = "persist:dpcode-browser";
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS = 1_500;
const BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS = 400;
const BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD = 1;
const BROWSER_THREAD_SUSPEND_DELAY_MS = 30_000;
const BROWSER_ERROR_ABORTED = -3;
const SEARCH_URL_PREFIX = "https://www.google.com/search?q=";

type BrowserStateListener = (state: ThreadBrowserState) => void;

interface LiveTabRuntime {
  key: string;
  threadId: ThreadId;
  tabId: string;
  view: WebContentsView;
}

interface NativeBrowserViewVisibility {
  setVisible?: (visible: boolean) => void;
}

interface PendingRuntimeSync {
  threadId: ThreadId;
  tabId: string;
  faviconUrls?: string[];
}

const LIVE_TAB_STATUS: BrowserTabState["status"] = "live";
const SUSPENDED_TAB_STATUS: BrowserTabState["status"] = "suspended";

interface BrowserPerformanceSnapshot {
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

function createBrowserTab(url = ABOUT_BLANK_URL): BrowserTabState {
  return {
    id: Crypto.randomUUID(),
    url,
    title: defaultTitleForUrl(url),
    status: SUSPENDED_TAB_STATUS,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: null,
    lastError: null,
  };
}

function defaultThreadBrowserState(threadId: ThreadId): ThreadBrowserState {
  return {
    threadId,
    version: 0,
    open: false,
    activeTabId: null,
    tabs: [],
    lastError: null,
  };
}

function cloneThreadState(state: ThreadBrowserState): ThreadBrowserState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
  };
}

function defaultTitleForUrl(url: string): string {
  if (url === ABOUT_BLANK_URL) {
    return "New tab";
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function screenshotFileNameForUrl(url: string): string {
  const fallback = "browser";
  try {
    const hostname = new URL(url).hostname.trim().toLowerCase();
    const normalizedHost = hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${normalizedHost || fallback}-${Date.now()}.png`;
  } catch {
    return `${fallback}-${Date.now()}.png`;
  }
}

function normalizeBounds(bounds: BrowserPanelBounds | null): BrowserPanelBounds | null {
  if (!bounds) return null;
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    return null;
  }

  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  if (width === 0 || height === 0) {
    return null;
  }

  return {
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
    width,
    height,
  };
}

function looksLikeUrlInput(value: string): boolean {
  return (
    value.includes(".") ||
    value.startsWith("localhost") ||
    value.startsWith("127.0.0.1") ||
    value.startsWith("0.0.0.0") ||
    value.startsWith("[::1]")
  );
}

function normalizeUrlInput(input: string | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0) {
    return ABOUT_BLANK_URL;
  }

  try {
    const withScheme = new URL(trimmed);
    if (withScheme.protocol === "http:" || withScheme.protocol === "https:") {
      return withScheme.toString();
    }
    if (withScheme.protocol === "about:") {
      return withScheme.toString();
    }
  } catch {
    // Fall through to heuristics below.
  }

  if (trimmed.includes(" ")) {
    return `${SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
  }

  if (looksLikeUrlInput(trimmed)) {
    const prefersHttp =
      trimmed.startsWith("localhost") ||
      trimmed.startsWith("127.0.0.1") ||
      trimmed.startsWith("0.0.0.0") ||
      trimmed.startsWith("[::1]");
    const scheme = prefersHttp ? "http" : "https";
    try {
      return new URL(`${scheme}://${trimmed}`).toString();
    } catch {
      return `${SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
    }
  }

  return `${SEARCH_URL_PREFIX}${encodeURIComponent(trimmed)}`;
}

function isAbortedNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /ERR_ABORTED|\(-3\)/i.test(error.message);
}

function mapBrowserLoadError(errorCode: number): string {
  switch (errorCode) {
    case -102:
      return "Connection refused.";
    case -105:
      return "Couldn't resolve this address.";
    case -106:
      return "You're offline.";
    case -118:
      return "This page took too long to respond.";
    case -137:
      return "A secure connection couldn't be established.";
    case -200:
      return "A secure connection couldn't be established.";
    default:
      return "Couldn't open this page.";
  }
}

function buildRuntimeKey(threadId: ThreadId, tabId: string): string {
  return `${threadId}:${tabId}`;
}

function browserBoundsSignature(bounds: BrowserPanelBounds | null): string {
  if (!bounds) {
    return "hidden";
  }

  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

export class DesktopBrowserManager {
  private window: BrowserWindow | null = null;
  private activeThreadId: ThreadId | null = null;
  private activeBounds: BrowserPanelBounds | null = null;
  private activeBoundsThreadId: ThreadId | null = null;
  private attachedRuntimeKey: string | null = null;
  private attachedBoundsSignature: string | null = null;
  private readonly states = new Map<ThreadId, ThreadBrowserState>();
  private readonly threadVersionById = new Map<ThreadId, number>();
  private readonly snapshotCacheByThreadId = new Map<
    ThreadId,
    { version: number; snapshot: ThreadBrowserState }
  >();
  private readonly lastEmittedVersionByThreadId = new Map<ThreadId, number>();
  private readonly runtimes = new Map<string, LiveTabRuntime>();
  private readonly runtimeLastActiveAtByKey = new Map<string, number>();
  private readonly pendingRuntimeSyncs = new Map<string, PendingRuntimeSync>();
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly tabSuspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly suspendTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  private runtimeSyncFlushScheduled = false;
  private readonly perfCounters = {
    setPanelBoundsCalls: 0,
    setPanelBoundsNoopSkips: 0,
    setPanelBoundsViewportUpdates: 0,
    stateEmitCalls: 0,
    stateEmitSkips: 0,
    stateCloneCount: 0,
    runtimeSyncQueueFlushes: 0,
    syncRuntimeStateCalls: 0,
    inactiveTabSuspendScheduled: 0,
    inactiveTabSuspendCancelled: 0,
    inactiveTabBudgetEvictions: 0,
    warmInactiveRuntimeCount: 0,
  };

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (window) {
      const bounds = this.activeThreadId
        ? this.getVisibleBoundsForThread(this.activeThreadId)
        : null;
      if (this.activeThreadId && bounds) {
        this.attachActiveTab(this.activeThreadId, bounds);
      }
      return;
    }

    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
  }

  subscribe(listener: BrowserStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    for (const timer of this.tabSuspendTimers.values()) {
      clearTimeout(timer);
    }
    this.tabSuspendTimers.clear();
    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.pendingRuntimeSyncs.clear();
    this.runtimeLastActiveAtByKey.clear();
    this.listeners.clear();
    this.states.clear();
    this.threadVersionById.clear();
    this.snapshotCacheByThreadId.clear();
    this.lastEmittedVersionByThreadId.clear();
    this.window = null;
    this.activeThreadId = null;
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
    this.attachedBoundsSignature = null;
    this.runtimeSyncFlushScheduled = false;
  }

  getPerformanceSnapshot(): BrowserPerformanceSnapshot {
    this.perfCounters.warmInactiveRuntimeCount = this.countWarmInactiveRuntimes();
    return {
      counters: { ...this.perfCounters },
      trackedProcessIds: this.getTrackedProcessIds(),
    };
  }

  getBrowserUseSnapshot(): BrowserUseSnapshot | null {
    if (!this.activeThreadId || !this.getVisibleBoundsForThread(this.activeThreadId)) {
      return null;
    }
    const state = this.states.get(this.activeThreadId);
    if (!state) {
      return null;
    }
    return {
      threadId: this.activeThreadId,
      state: this.snapshotThreadState(this.activeThreadId, state),
    };
  }

  open(input: BrowserOpenInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId, input.initialUrl);
    const didChange = !state.open;
    state.open = true;
    const nextDidChange = syncThreadLastError(state) || didChange;

    if (
      this.activeBounds &&
      this.activeBoundsThreadId === input.threadId &&
      (this.activeThreadId === null || this.activeThreadId === input.threadId)
    ) {
      this.activateThread(input.threadId, this.activeBounds);
    }

    if (nextDidChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  close(input: BrowserThreadInput): ThreadBrowserState {
    this.clearSuspendTimer(input.threadId);

    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }
    this.clearActiveBoundsForThread(input.threadId);

    this.destroyThreadRuntimes(input.threadId);

    const state = this.getOrCreateState(input.threadId);
    state.open = false;
    state.activeTabId = null;
    state.tabs = [];
    state.lastError = null;
    this.markThreadStateChanged(input.threadId);
    this.lastEmittedVersionByThreadId.delete(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  hide(input: BrowserThreadInput): void {
    const state = this.states.get(input.threadId);
    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }
    this.clearActiveBoundsForThread(input.threadId);

    if (!state?.open) {
      return;
    }

    this.scheduleThreadSuspend(input.threadId);
  }

  getState(input: BrowserThreadInput): ThreadBrowserState {
    return this.snapshotThreadState(input.threadId);
  }

  setPanelBounds(input: BrowserSetPanelBoundsInput): void {
    this.perfCounters.setPanelBoundsCalls += 1;
    const state = this.getOrCreateState(input.threadId);
    const nextBounds = normalizeBounds(input.bounds);
    const nextBoundsSignature = browserBoundsSignature(nextBounds);
    const activeTabId = this.getActiveTab(state)?.id ?? null;
    const activeRuntimeKey = activeTabId ? buildRuntimeKey(input.threadId, activeTabId) : null;
    this.setActiveBounds(input.threadId, nextBounds);

    if (!state.open || nextBounds === null) {
      if (this.activeThreadId === input.threadId) {
        this.detachAttachedRuntime();
        this.activeThreadId = null;
        this.scheduleThreadSuspend(input.threadId);
      }
      return;
    }

    // Bounds sync fires often during panel motion. If the visible runtime and
    // applied viewport are already current, avoid waking the browser stack again.
    if (
      this.activeThreadId === input.threadId &&
      this.attachedRuntimeKey === activeRuntimeKey &&
      this.attachedBoundsSignature === nextBoundsSignature
    ) {
      this.perfCounters.setPanelBoundsNoopSkips += 1;
      return;
    }

    if (this.activeThreadId === input.threadId) {
      if (activeRuntimeKey && this.attachedRuntimeKey === activeRuntimeKey) {
        const runtime = this.runtimes.get(activeRuntimeKey);
        if (runtime) {
          this.perfCounters.setPanelBoundsViewportUpdates += 1;
          this.attachRuntime(runtime, nextBounds);
          return;
        }
      }
      this.attachActiveTab(input.threadId, nextBounds);
      return;
    }

    this.activateThread(input.threadId, nextBounds);
  }

  navigate(input: BrowserNavigateInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const nextUrl = normalizeUrlInput(input.url);
    tab.url = nextUrl;
    tab.title = defaultTitleForUrl(nextUrl);
    tab.lastCommittedUrl = null;
    tab.lastError = null;
    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);

    if (this.activeThreadId === input.threadId) {
      // Load the target tab directly so we don't clobber its pending URL with a
      // thread-wide runtime sync from the old live page state.
      const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
      this.clearSuspendTimer(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.attachRuntime(runtime, bounds);
      }
      void this.loadTab(input.threadId, tab.id, { force: true, runtime });
    }

    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  reload(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, tab.id));
    if (runtime) {
      runtime.view.webContents.reload();
    } else if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      void this.loadTab(input.threadId, tab.id, { force: true });
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  goBack(input: BrowserTabInput): ThreadBrowserState {
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && runtime.view.webContents.canGoBack()) {
      runtime.view.webContents.goBack();
    }
    return this.getState({ threadId: input.threadId });
  }

  goForward(input: BrowserTabInput): ThreadBrowserState {
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (runtime && runtime.view.webContents.canGoForward()) {
      runtime.view.webContents.goForward();
    }
    return this.getState({ threadId: input.threadId });
  }

  newTab(input: BrowserNewTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = createBrowserTab(normalizeUrlInput(input.url));
    state.tabs = [...state.tabs, tab];
    if (input.activate !== false || !state.activeTabId) {
      state.activeTabId = tab.id;
    }

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.ensureLiveRuntime(input.threadId, tab.id);
        void this.loadTab(input.threadId, tab.id, { force: true });
        this.attachActiveTab(input.threadId, bounds);
      }
    } else {
      tab.status = "suspended";
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  closeTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
    if (nextTabs.length === state.tabs.length) {
      return this.snapshotThreadState(input.threadId, state);
    }

    this.destroyRuntime(input.threadId, input.tabId);
    state.tabs = nextTabs;

    if (nextTabs.length === 0) {
      state.open = false;
      state.activeTabId = null;
      state.lastError = null;
      if (this.activeThreadId === input.threadId) {
        this.detachAttachedRuntime();
        this.activeThreadId = null;
      }
      this.clearActiveBoundsForThread(input.threadId);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
      return this.snapshotThreadState(input.threadId, state);
    }

    if (!state.activeTabId || state.activeTabId === input.tabId) {
      state.activeTabId = nextTabs[Math.max(0, nextTabs.length - 1)]?.id ?? null;
    }

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (this.activeThreadId === input.threadId && bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    syncThreadLastError(state);
    this.markThreadStateChanged(input.threadId);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  selectTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (bounds) {
        this.attachActiveTab(input.threadId, bounds);
      }
    }

    return this.snapshotThreadState(input.threadId, state);
  }

  openDevTools(input: BrowserTabInput): void {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }
    runtime.view.webContents.openDevTools({ mode: "detach" });
  }

  // Ensures the requested tab is active/live, then returns a fresh PNG capture
  // from the native browser surface for whichever destination needs it next.
  private async captureScreenshotPng(input: BrowserTabInput): Promise<{
    name: string;
    pngBytes: Buffer;
  }> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.view.webContents;
    const expectedUrl = normalizeUrlInput(tab.lastCommittedUrl ?? tab.url);
    const currentUrl = webContents.getURL();
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    if (tab.status === "suspended" || currentUrl.length === 0 || currentUrl !== expectedUrl) {
      await this.loadTab(input.threadId, tab.id, { runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    const pngBytes = (await webContents.capturePage()).toPNG();
    if (pngBytes.byteLength === 0) {
      throw new Error("Couldn't capture a browser screenshot.");
    }

    return {
      name: screenshotFileNameForUrl(tab.lastCommittedUrl ?? tab.url),
      pngBytes,
    };
  }

  // Captures the current browser viewport as a PNG so the renderer can attach
  // it directly to the composer without introducing temp-file disk churn.
  async captureScreenshot(input: BrowserTabInput): Promise<BrowserCaptureScreenshotResult> {
    const { name, pngBytes } = await this.captureScreenshotPng(input);

    return {
      name,
      mimeType: "image/png",
      sizeBytes: pngBytes.byteLength,
      bytes: Uint8Array.from(pngBytes),
    };
  }

  // Writes the current browser viewport screenshot straight to the native
  // clipboard so the renderer does not have to ferry image payloads over IPC.
  async copyScreenshotToClipboard(input: BrowserTabInput): Promise<void> {
    const { pngBytes } = await this.captureScreenshotPng(input);
    const image = nativeImage.createFromBuffer(pngBytes);
    if (image.isEmpty()) {
      throw new Error("Couldn't copy a browser screenshot to the clipboard.");
    }
    clipboard.writeImage(image);
  }

  // Runs a Chrome DevTools Protocol command against the requested tab so higher-level
  // browser automation can reuse the native browser runtime instead of scripting React.
  async executeCdp(input: BrowserExecuteCdpInput): Promise<unknown> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.view.webContents;
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.attachActiveTab(input.threadId, bounds);
    }

    if (tab.status === "suspended") {
      await this.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    try {
      return await webContents.debugger.sendCommand(input.method, input.params ?? {});
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`CDP ${input.method} failed: ${error.message}`);
      }
      throw error;
    }
  }

  async attachBrowserUseTab(input: BrowserTabInput): Promise<void> {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    if (this.activeBounds && this.activeBoundsThreadId === input.threadId) {
      this.activateThread(input.threadId, this.activeBounds);
    }

    if (tab.status === "suspended") {
      await this.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.queueRuntimeStateSync(input.threadId, tab.id);
    }

    if (!runtime.view.webContents.debugger.isAttached()) {
      runtime.view.webContents.debugger.attach("1.3");
    }
  }

  subscribeToCdpEvents(
    input: BrowserTabInput,
    listener: (event: BrowserUseCdpEvent) => void,
  ): () => void {
    const runtime = this.runtimes.get(buildRuntimeKey(input.threadId, input.tabId));
    if (!runtime) {
      return () => {};
    }

    const handleMessage = (_event: Electron.Event, method: string, params?: unknown) => {
      listener({
        method,
        ...(params !== undefined ? { params } : {}),
      });
    };

    runtime.view.webContents.debugger.on("message", handleMessage);
    return () => {
      runtime.view.webContents.debugger.removeListener("message", handleMessage);
    };
  }

  private activateThread(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    if (this.activeThreadId && this.activeThreadId !== threadId) {
      this.scheduleThreadSuspend(this.activeThreadId);
    }

    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
    this.resumeThread(threadId);
    this.attachActiveTab(threadId, bounds);
  }

  private setActiveBounds(threadId: ThreadId, bounds: BrowserPanelBounds | null): void {
    if (!bounds) {
      this.clearActiveBoundsForThread(threadId);
      return;
    }
    this.activeBounds = bounds;
    this.activeBoundsThreadId = threadId;
  }

  private clearActiveBoundsForThread(threadId: ThreadId): void {
    if (this.activeBoundsThreadId !== threadId) {
      return;
    }
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
  }

  private getVisibleBoundsForThread(threadId: ThreadId): BrowserPanelBounds | null {
    return this.activeBoundsThreadId === threadId ? this.activeBounds : null;
  }

  private resumeThread(threadId: ThreadId): void {
    const state = this.ensureWorkspace(threadId);
    if (!state.open) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const activeTab = this.getActiveTab(state);
    let didChange = this.suspendInactiveTabs(threadId, activeTab?.id ?? null);

    // Only resume the visible tab. Waking every tab can fan out into several
    // Chromium renderer processes and background page activity at once.
    for (const tab of state.tabs) {
      if (tab.id !== activeTab?.id) {
        continue;
      }
      const runtime = this.ensureLiveRuntime(threadId, tab.id);
      if (tab.status === "suspended") {
        void this.loadTab(threadId, tab.id, { force: true, runtime });
      } else {
        didChange = syncTabStateFromRuntime(state, tab, runtime.view.webContents) || didChange;
      }
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private suspendInactiveTabs(threadId: ThreadId, activeTabId: string | null): boolean {
    const state = this.states.get(threadId);
    if (!state) {
      return false;
    }

    let didChange = false;
    const inactiveRuntimeTabIds = state.tabs
      .filter((tab) => tab.id !== activeTabId)
      .filter((tab) => this.runtimes.has(buildRuntimeKey(threadId, tab.id)))
      .sort((left, right) => {
        const leftKey = buildRuntimeKey(threadId, left.id);
        const rightKey = buildRuntimeKey(threadId, right.id);
        return (
          (this.runtimeLastActiveAtByKey.get(rightKey) ?? 0) -
          (this.runtimeLastActiveAtByKey.get(leftKey) ?? 0)
        );
      });
    const warmRuntimeTabIds = new Set(
      inactiveRuntimeTabIds
        .slice(0, BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD)
        .map((tab) => tab.id),
    );

    for (const tab of state.tabs) {
      if (tab.id === activeTabId) {
        this.clearTabSuspendTimer(threadId, tab.id);
        continue;
      }

      const runtime = this.runtimes.get(buildRuntimeKey(threadId, tab.id));
      if (runtime) {
        if (warmRuntimeTabIds.has(tab.id)) {
          this.scheduleInactiveTabSuspend(threadId, tab.id);
          continue;
        }

        this.perfCounters.inactiveTabBudgetEvictions += 1;
        this.destroyRuntime(threadId, tab.id);
        didChange = suspendTabState(tab) || didChange;
        continue;
      }

      didChange = suspendTabState(tab) || didChange;
    }

    return didChange;
  }

  private scheduleThreadSuspend(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state?.open || this.activeThreadId === threadId) {
      return;
    }

    this.clearSuspendTimer(threadId);
    const timer = setTimeout(() => {
      this.suspendThread(threadId);
      this.suspendTimers.delete(threadId);
    }, BROWSER_THREAD_SUSPEND_DELAY_MS);
    timer.unref();
    this.suspendTimers.set(threadId, timer);
  }

  private suspendThread(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state || this.activeThreadId === threadId) {
      return;
    }

    let didChange = false;
    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
      didChange = suspendTabState(tab) || didChange;
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private clearSuspendTimer(threadId: ThreadId): void {
    const existing = this.suspendTimers.get(threadId);
    if (!existing) {
      return;
    }
    clearTimeout(existing);
    this.suspendTimers.delete(threadId);
  }

  private scheduleInactiveTabSuspend(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    if (this.tabSuspendTimers.has(key)) {
      return;
    }

    this.perfCounters.inactiveTabSuspendScheduled += 1;
    const delayMs = this.resolveInactiveTabSuspendDelay(threadId);
    const timer = setTimeout(() => {
      this.tabSuspendTimers.delete(key);
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      this.destroyRuntime(threadId, tabId);
      const didChange = suspendTabState(tab) || syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
    }, delayMs);
    timer.unref();
    this.tabSuspendTimers.set(key, timer);
  }

  private clearTabSuspendTimer(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.tabSuspendTimers.get(key);
    if (!existing) {
      return;
    }

    clearTimeout(existing);
    this.tabSuspendTimers.delete(key);
    this.perfCounters.inactiveTabSuspendCancelled += 1;
  }

  private attachActiveTab(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const state = this.ensureWorkspace(threadId);
    const activeTab = this.getActiveTab(state);
    if (!activeTab) {
      return;
    }

    this.suspendInactiveTabs(threadId, activeTab.id);
    const runtime = this.ensureLiveRuntime(threadId, activeTab.id);
    this.attachRuntime(runtime, bounds);
    if (activeTab.status === "suspended") {
      void this.loadTab(threadId, activeTab.id, { force: true, runtime });
    } else {
      this.syncRuntimeState(threadId, activeTab.id);
    }
  }

  private attachRuntime(runtime: LiveTabRuntime, bounds: BrowserPanelBounds): void {
    const window = this.window;
    if (!window) {
      return;
    }

    const nextBoundsSignature = browserBoundsSignature(bounds);
    this.runtimeLastActiveAtByKey.set(runtime.key, Date.now());
    if (this.attachedRuntimeKey === runtime.key) {
      if (this.attachedBoundsSignature === nextBoundsSignature) {
        return;
      }
      this.setRuntimeViewHidden(runtime, false);
      runtime.view.setBounds(bounds);
      this.attachedBoundsSignature = nextBoundsSignature;
      return;
    }

    this.detachAttachedRuntime();
    this.setRuntimeViewHidden(runtime, false);
    window.contentView.addChildView(runtime.view);
    runtime.view.setBounds(bounds);
    this.attachedRuntimeKey = runtime.key;
    this.attachedBoundsSignature = nextBoundsSignature;
  }

  private detachAttachedRuntime(): void {
    if (!this.window || !this.attachedRuntimeKey) {
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
      return;
    }

    const runtime = this.runtimes.get(this.attachedRuntimeKey);
    if (runtime) {
      this.setRuntimeViewHidden(runtime, true);
      this.window.contentView.removeChildView(runtime.view);
    }
    this.attachedRuntimeKey = null;
    this.attachedBoundsSignature = null;
  }

  private setRuntimeViewHidden(runtime: LiveTabRuntime, hidden: boolean): void {
    const nativeView = runtime.view as typeof runtime.view & NativeBrowserViewVisibility;
    nativeView.setVisible?.(!hidden);
    if (hidden) {
      runtime.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  private ensureLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) {
      return existing;
    }

    const runtime = this.createLiveRuntime(threadId, tabId);
    this.runtimes.set(key, runtime);
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (tab) {
      const didChange = tab.status !== "live" || tab.lastError !== null;
      tab.status = "live";
      tab.lastError = null;
      syncThreadLastError(state);
      if (didChange) {
        this.markThreadStateChanged(threadId);
      }
    }
    return runtime;
  }

  private createLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_SESSION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const runtime: LiveTabRuntime = {
      key: buildRuntimeKey(threadId, tabId),
      threadId,
      tabId,
      view,
    };
    const webContents = view.webContents;

    webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://") || url === ABOUT_BLANK_URL) {
        this.newTab({
          threadId,
          url,
          activate: true,
        });
        const bounds = this.getVisibleBoundsForThread(threadId);
        if (this.activeThreadId === threadId && bounds) {
          this.attachActiveTab(threadId, bounds);
        }
        return { action: "deny" };
      }

      void shell.openExternal(url);
      return { action: "deny" };
    });

    webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      this.queueRuntimeStateSync(threadId, tabId);
    });
    webContents.on("page-favicon-updated", (_event, faviconUrls) => {
      this.queueRuntimeStateSync(threadId, tabId, faviconUrls);
    });
    webContents.on("did-start-loading", () => {
      this.queueRuntimeStateSync(threadId, tabId);
    });
    webContents.on("did-stop-loading", () => {
      this.queueRuntimeStateSync(threadId, tabId);
    });
    webContents.on("did-navigate", () => {
      this.queueRuntimeStateSync(threadId, tabId);
    });
    webContents.on("did-navigate-in-page", () => {
      this.queueRuntimeStateSync(threadId, tabId);
    });
    webContents.on(
      "did-fail-load",
      (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === BROWSER_ERROR_ABORTED) {
          return;
        }

        const state = this.states.get(threadId);
        const tab = state ? this.getTab(state, tabId) : null;
        if (!state || !tab) {
          return;
        }

        tab.url = validatedURL || tab.url;
        tab.title = defaultTitleForUrl(tab.url);
        tab.isLoading = false;
        tab.lastError = mapBrowserLoadError(errorCode);
        syncThreadLastError(state);
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      },
    );
    webContents.on("render-process-gone", () => {
      const state = this.states.get(threadId);
      const tab = state ? this.getTab(state, tabId) : null;
      this.destroyRuntime(threadId, tabId);
      if (state && tab) {
        tab.status = "suspended";
        tab.isLoading = false;
        tab.lastError = "This tab stopped unexpectedly.";
        syncThreadLastError(state);
        this.markThreadStateChanged(threadId);
        this.emitState(threadId);
      }
      const bounds = this.getVisibleBoundsForThread(threadId);
      if (this.activeThreadId === threadId && bounds) {
        this.attachActiveTab(threadId, bounds);
      }
    });

    return runtime;
  }

  private async loadTab(
    threadId: ThreadId,
    tabId: string,
    options: { force?: boolean; runtime?: LiveTabRuntime } = {},
  ): Promise<void> {
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (!tab) {
      return;
    }

    const runtime = options.runtime ?? this.ensureLiveRuntime(threadId, tabId);
    const webContents = runtime.view.webContents;
    const nextUrl = normalizeUrlInput(
      options.force === true ? tab.url : (tab.lastCommittedUrl ?? tab.url),
    );
    const currentUrl = webContents.getURL();
    const shouldLoad = options.force === true || currentUrl !== nextUrl || currentUrl.length === 0;

    if (!shouldLoad) {
      this.queueRuntimeStateSync(threadId, tabId);
      return;
    }

    tab.url = nextUrl;
    tab.status = "live";
    tab.isLoading = true;
    tab.lastError = null;
    syncThreadLastError(state);
    this.markThreadStateChanged(threadId);
    this.emitState(threadId);

    try {
      await webContents.loadURL(nextUrl);
      this.queueRuntimeStateSync(threadId, tabId);
    } catch (error) {
      if (isAbortedNavigationError(error)) {
        this.queueRuntimeStateSync(threadId, tabId);
        return;
      }

      tab.isLoading = false;
      tab.lastError = "Couldn't open this page.";
      syncThreadLastError(state);
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private syncRuntimeState(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    this.perfCounters.syncRuntimeStateCalls += 1;
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!state || !tab || !runtime) {
      return;
    }

    const didChange = syncTabStateFromRuntime(state, tab, runtime.view.webContents, faviconUrls);
    const nextDidChange = syncThreadLastError(state) || didChange;
    if (nextDidChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
  }

  private queueRuntimeStateSync(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.pendingRuntimeSyncs.get(key);
    const nextPendingSync: PendingRuntimeSync = {
      threadId,
      tabId,
    };
    const nextFaviconUrls = faviconUrls ?? existing?.faviconUrls;
    if (nextFaviconUrls !== undefined) {
      nextPendingSync.faviconUrls = nextFaviconUrls;
    }
    this.pendingRuntimeSyncs.set(key, nextPendingSync);

    if (this.runtimeSyncFlushScheduled) {
      return;
    }

    this.runtimeSyncFlushScheduled = true;
    queueMicrotask(() => {
      this.runtimeSyncFlushScheduled = false;
      if (this.pendingRuntimeSyncs.size === 0) {
        return;
      }

      this.perfCounters.runtimeSyncQueueFlushes += 1;
      const pendingSyncs = [...this.pendingRuntimeSyncs.values()];
      this.pendingRuntimeSyncs.clear();
      for (const pendingSync of pendingSyncs) {
        this.syncRuntimeState(pendingSync.threadId, pendingSync.tabId, pendingSync.faviconUrls);
      }
    });
  }

  private destroyThreadRuntimes(threadId: ThreadId): void {
    const state = this.states.get(threadId);
    if (!state) {
      return;
    }

    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
    }
  }

  private destroyAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      this.destroyRuntime(runtime.threadId, runtime.tabId);
    }
  }

  private destroyRuntime(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    this.pendingRuntimeSyncs.delete(key);
    this.runtimeLastActiveAtByKey.delete(key);
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      return;
    }

    if (this.attachedRuntimeKey === key) {
      this.detachAttachedRuntime();
    }

    this.runtimes.delete(key);
    const webContents = runtime.view.webContents;
    if (!webContents.isDestroyed()) {
      if (webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach();
        } catch {
          // The runtime is being torn down anyway; ignore stale-debugger cleanup noise.
        }
      }
      webContents.close({ waitForBeforeUnload: false });
    }
  }

  private getOrCreateState(threadId: ThreadId): ThreadBrowserState {
    const existing = this.states.get(threadId);
    if (existing) {
      return existing;
    }

    const initial = defaultThreadBrowserState(threadId);
    this.states.set(threadId, initial);
    this.threadVersionById.set(threadId, 0);
    return initial;
  }

  private markThreadStateChanged(threadId: ThreadId): void {
    const nextVersion = (this.threadVersionById.get(threadId) ?? 0) + 1;
    this.threadVersionById.set(threadId, nextVersion);
    const state = this.states.get(threadId);
    if (state) {
      state.version = nextVersion;
    }
  }

  private snapshotThreadState(
    threadId: ThreadId,
    state = this.getOrCreateState(threadId),
  ): ThreadBrowserState {
    const version = state.version;
    const cached = this.snapshotCacheByThreadId.get(threadId);
    if (cached && cached.version === version) {
      return cached.snapshot;
    }

    const snapshot = cloneThreadState(state);
    this.perfCounters.stateCloneCount += 1;
    this.snapshotCacheByThreadId.set(threadId, {
      version,
      snapshot,
    });
    return snapshot;
  }

  private getTrackedProcessIds(): number[] {
    const processIds = new Set<number>();
    for (const runtime of this.runtimes.values()) {
      const webContents = runtime.view.webContents;
      if (webContents.isDestroyed()) {
        continue;
      }
      processIds.add(webContents.getProcessId());
    }
    return [...processIds];
  }

  private countWarmInactiveRuntimes(): number {
    let count = 0;
    for (const [key] of this.tabSuspendTimers) {
      if (this.runtimes.has(key)) {
        count += 1;
      }
    }
    return count;
  }

  private resolveInactiveTabSuspendDelay(threadId: ThreadId): number {
    const threadRuntimeCount = [...this.runtimes.values()].filter(
      (runtime) => runtime.threadId === threadId,
    ).length;
    if (
      threadRuntimeCount > BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD + 1 ||
      this.runtimes.size > 4
    ) {
      return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS;
    }

    return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS;
  }

  private ensureWorkspace(threadId: ThreadId, initialUrl?: string): ThreadBrowserState {
    const state = this.getOrCreateState(threadId);
    if (state.tabs.length === 0) {
      const initialTab = createBrowserTab(normalizeUrlInput(initialUrl));
      state.tabs = [initialTab];
      state.activeTabId = initialTab.id;
    }

    if (!state.activeTabId || !state.tabs.some((tab) => tab.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0]?.id ?? null;
    }

    return state;
  }

  private resolveTab(state: ThreadBrowserState, tabId?: string): BrowserTabState {
    const resolvedTabId = tabId ?? state.activeTabId;
    const existing =
      (resolvedTabId ? state.tabs.find((tab) => tab.id === resolvedTabId) : undefined) ??
      state.tabs[0];
    if (existing) {
      return existing;
    }

    const fallback = createBrowserTab();
    state.tabs = [fallback];
    state.activeTabId = fallback.id;
    return fallback;
  }

  private getActiveTab(state: ThreadBrowserState): BrowserTabState | null {
    if (!state.activeTabId) {
      return state.tabs[0] ?? null;
    }
    return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
  }

  private getTab(state: ThreadBrowserState, tabId: string): BrowserTabState | null {
    return state.tabs.find((tab) => tab.id === tabId) ?? null;
  }

  private emitState(threadId: ThreadId): void {
    this.perfCounters.stateEmitCalls += 1;
    const state = this.getOrCreateState(threadId);
    const nextVersion = state.version;
    if (this.lastEmittedVersionByThreadId.get(threadId) === nextVersion) {
      this.perfCounters.stateEmitSkips += 1;
      return;
    }
    this.lastEmittedVersionByThreadId.set(threadId, nextVersion);
    const snapshot = this.snapshotThreadState(threadId, state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function setIfChanged<T>(current: T, next: T, apply: (value: T) => void): boolean {
  if (Object.is(current, next)) {
    return false;
  }
  apply(next);
  return true;
}

function suspendTabState(tab: BrowserTabState): boolean {
  let didChange = false;
  didChange =
    setIfChanged(tab.status, SUSPENDED_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, false, (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, false, (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, false, (value) => {
      tab.canGoForward = value;
    }) || didChange;
  return didChange;
}

function syncTabStateFromRuntime(
  state: ThreadBrowserState,
  tab: BrowserTabState,
  webContents: WebContentsView["webContents"],
  faviconUrls?: string[],
): boolean {
  const currentUrl = webContents.getURL();
  const nextUrl = currentUrl || tab.url;
  const nextTitle = webContents.getTitle();
  let didChange = false;
  didChange =
    setIfChanged(tab.status, LIVE_TAB_STATUS, (value) => {
      tab.status = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.url, nextUrl, (value) => {
      tab.url = value;
    }) || didChange;
  const resolvedTitle =
    !nextTitle || nextTitle === ABOUT_BLANK_URL ? defaultTitleForUrl(nextUrl) : nextTitle;
  didChange =
    setIfChanged(tab.title, resolvedTitle, (value) => {
      tab.title = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.isLoading, webContents.isLoading(), (value) => {
      tab.isLoading = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoBack, webContents.canGoBack(), (value) => {
      tab.canGoBack = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.canGoForward, webContents.canGoForward(), (value) => {
      tab.canGoForward = value;
    }) || didChange;
  didChange =
    setIfChanged(tab.lastCommittedUrl, currentUrl || tab.lastCommittedUrl, (value) => {
      tab.lastCommittedUrl = value;
    }) || didChange;
  if (faviconUrls) {
    didChange =
      setIfChanged(tab.faviconUrl, faviconUrls[0] ?? tab.faviconUrl, (value) => {
        tab.faviconUrl = value;
      }) || didChange;
  }
  if (tab.lastError && !tab.isLoading) {
    tab.lastError = null;
    didChange = true;
  }
  didChange = syncThreadLastError(state) || didChange;
  return didChange;
}

function syncThreadLastError(state: ThreadBrowserState): boolean {
  const activeTab =
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  const nextLastError = activeTab?.lastError ?? null;
  if (state.lastError === nextLastError) {
    return false;
  }
  state.lastError = nextLastError;
  return true;
}
