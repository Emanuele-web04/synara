// FILE: browserManager.ts
// Purpose: Owns the desktop in-app browser thread/tab state model and the public IPC surface,
//   delegating the electron-bound runtime layer to BrowserRuntimeController.
// Layer: Desktop runtime manager
// Depends on: Electron BrowserWindow/WebContentsView, browserManager.runtime, shared browser IPC contracts

import {
  BrowserWindow,
  clipboard,
  nativeImage,
  shell,
  webContents as electronWebContents,
  WebContentsView,
} from "electron";
import type {
  BrowserAttachWebviewInput,
  BrowserCaptureScreenshotResult,
  BrowserCopyLinkEvent,
  BrowserDetachWebviewInput,
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
import { resolveCopyableBrowserTabUrl } from "@t3tools/shared/browserSession";

import {
  BROWSER_THREAD_SUSPEND_DELAY_MS,
  LIVE_TAB_STATUS,
  SUSPENDED_TAB_STATUS,
} from "./browserManager.types";
import type {
  BrowserPerformanceSnapshot,
  BrowserCopyLinkListener,
  BrowserStateListener,
  BrowserUseCdpEvent,
  BrowserUseSnapshot,
} from "./browserManager.types";
import {
  browserBoundsSignature,
  buildRuntimeKey,
  canWebContentsGoBack,
  canWebContentsGoForward,
  cloneThreadState,
  createBrowserTab,
  defaultThreadBrowserState,
  defaultTitleForUrl,
  normalizeBounds,
  normalizeUrlInput,
  screenshotFileNameForUrl,
  suspendTabState,
  syncTabStateFromRuntime,
  syncThreadLastError,
} from "./browserManager.helpers";
import { BrowserRuntimeController, type BrowserRuntimePerfCounter } from "./browserManager.runtime";

export type { BrowserUseSnapshot, BrowserUseCdpEvent } from "./browserManager.types";

export class DesktopBrowserManager {
  private window: BrowserWindow | null = null;
  private activeThreadId: ThreadId | null = null;
  private activeBounds: BrowserPanelBounds | null = null;
  private activeBoundsThreadId: ThreadId | null = null;
  private readonly states = new Map<ThreadId, ThreadBrowserState>();
  private readonly threadVersionById = new Map<ThreadId, number>();
  private readonly snapshotCacheByThreadId = new Map<
    ThreadId,
    { version: number; snapshot: ThreadBrowserState }
  >();
  private readonly lastEmittedVersionByThreadId = new Map<ThreadId, number>();
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly copyLinkListeners = new Set<BrowserCopyLinkListener>();
  private readonly suspendTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
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

  private readonly runtime = new BrowserRuntimeController(
    {
      getWindow: () => this.window,
      getActiveThreadId: () => this.activeThreadId,
      getState: (threadId) => this.states.get(threadId) ?? null,
      ensureWorkspace: (threadId) => this.ensureWorkspace(threadId),
      getTab: (state, tabId) => this.getTab(state, tabId),
      getActiveTab: (state) => this.getActiveTab(state),
      getVisibleBoundsForThread: (threadId) => this.getVisibleBoundsForThread(threadId),
      markThreadStateChanged: (threadId) => this.markThreadStateChanged(threadId),
      emitState: (threadId) => this.emitState(threadId),
      openNewTab: (input) => {
        this.newTab(input);
      },
      copyTabLink: (threadId, tabId) => this.copyTabLink(threadId, tabId),
      incrementCounter: (counter) => this.bumpRuntimeCounter(counter),
    },
    { WebContentsView, shell },
  );

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (window) {
      const bounds = this.activeThreadId
        ? this.getVisibleBoundsForThread(this.activeThreadId)
        : null;
      if (this.activeThreadId && bounds) {
        this.runtime.attachActiveTab(this.activeThreadId, bounds);
      }
      return;
    }

    this.runtime.detachAttachedRuntime();
    this.runtime.destroyAllRuntimes();
  }

  subscribe(listener: BrowserStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeCopyLink(listener: BrowserCopyLinkListener): () => void {
    this.copyLinkListeners.add(listener);
    return () => {
      this.copyLinkListeners.delete(listener);
    };
  }

  dispose(): void {
    for (const timer of this.suspendTimers.values()) {
      clearTimeout(timer);
    }
    this.suspendTimers.clear();
    this.runtime.clearAllTabSuspendTimers();
    this.runtime.detachAttachedRuntime();
    this.runtime.destroyAllRuntimes();
    this.runtime.clearRuntimeBookkeeping();
    this.listeners.clear();
    this.copyLinkListeners.clear();
    this.states.clear();
    this.threadVersionById.clear();
    this.snapshotCacheByThreadId.clear();
    this.lastEmittedVersionByThreadId.clear();
    this.window = null;
    this.activeThreadId = null;
    this.activeBounds = null;
    this.activeBoundsThreadId = null;
    this.runtime.resetAttachedPointers();
  }

  getPerformanceSnapshot(): BrowserPerformanceSnapshot {
    this.perfCounters.warmInactiveRuntimeCount = this.runtime.countWarmInactiveRuntimes();
    return {
      counters: { ...this.perfCounters },
      trackedProcessIds: this.runtime.getTrackedProcessIds(),
    };
  }

  getBrowserUseSnapshot(): BrowserUseSnapshot | null {
    if (this.activeThreadId) {
      const activeState = this.states.get(this.activeThreadId);
      if (activeState?.open) {
        return {
          threadId: this.activeThreadId,
          state: this.snapshotThreadState(this.activeThreadId, activeState),
        };
      }
    }

    for (const [threadId, state] of this.states) {
      if (state.open) {
        return {
          threadId,
          state: this.snapshotThreadState(threadId, state),
        };
      }
    }
    return null;
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
      this.runtime.detachAttachedRuntime();
      this.activeThreadId = null;
    }
    this.clearActiveBoundsForThread(input.threadId);

    this.runtime.destroyThreadRuntimes(input.threadId);

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
      this.runtime.detachAttachedRuntime();
      this.activeThreadId = null;
    }

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
    const activeRuntime = activeTabId ? this.runtime.getRuntime(input.threadId, activeTabId) : null;
    this.setActiveBounds(input.threadId, nextBounds);

    if (!state.open || nextBounds === null) {
      if (this.activeThreadId === input.threadId) {
        this.runtime.detachAttachedRuntime();
        this.activeThreadId = null;
        this.scheduleThreadSuspend(input.threadId);
      }
      return;
    }

    if (
      input.surface === "native" &&
      activeTabId &&
      activeRuntime &&
      !activeRuntime.ownsWebContents
    ) {
      // Sheet mode renders more reliably with the native WebContentsView than a translated <webview>.
      this.runtime.destroyRuntime(input.threadId, activeTabId);
      const activeTab = this.getTab(state, activeTabId);
      if (activeTab) {
        suspendTabState(activeTab);
        this.markThreadStateChanged(input.threadId);
      }
      this.runtime.resetAttachedPointers();
    }

    // Bounds sync fires often during panel motion. If the visible runtime and
    // applied viewport are already current, avoid waking the browser stack again.
    if (
      this.activeThreadId === input.threadId &&
      this.runtime.getAttachedRuntimeKey() === activeRuntimeKey &&
      this.runtime.getAttachedBoundsSignature() === nextBoundsSignature
    ) {
      this.perfCounters.setPanelBoundsNoopSkips += 1;
      return;
    }

    if (this.activeThreadId === input.threadId) {
      if (activeRuntimeKey && this.runtime.getAttachedRuntimeKey() === activeRuntimeKey) {
        const runtime = activeTabId ? this.runtime.getRuntime(input.threadId, activeTabId) : null;
        if (runtime) {
          this.perfCounters.setPanelBoundsViewportUpdates += 1;
          this.runtime.attachRuntime(runtime, nextBounds);
          return;
        }
      }
      this.runtime.attachActiveTab(input.threadId, nextBounds);
      return;
    }

    this.activateThread(input.threadId, nextBounds);
  }

  // Adopts the renderer-owned <webview> so the visible page and browser-use tools
  // share one WebContents instead of racing a hidden native WebContentsView.
  attachWebview(input: BrowserAttachWebviewInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const webContents = electronWebContents.fromId(input.webContentsId);
    if (!webContents || webContents.isDestroyed()) {
      throw new Error("The visible browser webview is not available.");
    }

    const existingRendererRuntime = this.runtime.findRendererRuntimeByWebContentsId(webContents.id);
    const key = buildRuntimeKey(input.threadId, tab.id);
    if (existingRendererRuntime && existingRendererRuntime.key !== key) {
      this.runtime.destroyRuntime(existingRendererRuntime.threadId, existingRendererRuntime.tabId);
    }

    const existing = this.runtime.getRuntime(input.threadId, tab.id);
    if (existing?.webContents.id !== webContents.id) {
      if (existing) {
        this.runtime.destroyRuntime(input.threadId, tab.id);
      }
      this.runtime.adoptRendererRuntime(input.threadId, tab.id, webContents);
    }

    const bounds = this.getVisibleBoundsForThread(input.threadId);
    const runtime = this.runtime.getRuntime(input.threadId, tab.id);
    if (runtime && bounds) {
      this.runtime.attachRuntime(runtime, bounds);
    }

    const didChange = tab.status !== LIVE_TAB_STATUS || tab.lastError !== null;
    tab.status = LIVE_TAB_STATUS;
    tab.lastError = null;
    syncThreadLastError(state);
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
    }
    this.runtime.queueRuntimeStateSync(input.threadId, tab.id);
    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  detachWebview(input: BrowserDetachWebviewInput): void {
    const state = this.states.get(input.threadId);
    const tab = state ? this.getTab(state, input.tabId) : null;
    if (!state || !tab) {
      return;
    }

    const didDetach = this.runtime.detachRendererRuntime(
      input.threadId,
      input.tabId,
      input.webContentsId,
    );
    if (!didDetach) {
      return;
    }

    const didChange = suspendTabState(tab) || syncThreadLastError(state);
    if (didChange) {
      this.markThreadStateChanged(input.threadId);
      this.emitState(input.threadId);
    }
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

    const runtime = this.runtime.getRuntime(input.threadId, tab.id);
    if (runtime) {
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.runtime.attachRuntime(runtime, bounds);
      }
      void this.runtime.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else if (this.activeThreadId === input.threadId) {
      // Load the target tab directly so we don't clobber its pending URL with a
      // thread-wide runtime sync from the old live page state.
      const nextRuntime = this.runtime.ensureLiveRuntime(input.threadId, tab.id);
      this.clearSuspendTimer(input.threadId);
      const bounds = this.getVisibleBoundsForThread(input.threadId);
      if (state.activeTabId === tab.id && bounds) {
        this.runtime.attachRuntime(nextRuntime, bounds);
      }
      void this.runtime.loadTab(input.threadId, tab.id, { force: true, runtime: nextRuntime });
    }

    this.emitState(input.threadId);
    return this.snapshotThreadState(input.threadId, state);
  }

  reload(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    const runtime = this.runtime.getRuntime(input.threadId, tab.id);
    if (runtime) {
      runtime.webContents.reload();
    } else if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      void this.runtime.loadTab(input.threadId, tab.id, { force: true });
    }
    return this.snapshotThreadState(input.threadId, state);
  }

  goBack(input: BrowserTabInput): ThreadBrowserState {
    const runtime = this.runtime.getRuntime(input.threadId, input.tabId);
    if (runtime && canWebContentsGoBack(runtime.webContents)) {
      runtime.webContents.goBack();
    }
    return this.getState({ threadId: input.threadId });
  }

  goForward(input: BrowserTabInput): ThreadBrowserState {
    const runtime = this.runtime.getRuntime(input.threadId, input.tabId);
    if (runtime && canWebContentsGoForward(runtime.webContents)) {
      runtime.webContents.goForward();
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
        this.runtime.ensureLiveRuntime(input.threadId, tab.id);
        void this.runtime.loadTab(input.threadId, tab.id, { force: true });
        this.runtime.attachActiveTab(input.threadId, bounds);
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

    this.runtime.destroyRuntime(input.threadId, input.tabId);
    state.tabs = nextTabs;

    if (nextTabs.length === 0) {
      state.open = false;
      state.activeTabId = null;
      state.lastError = null;
      if (this.activeThreadId === input.threadId) {
        this.runtime.detachAttachedRuntime();
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
      this.runtime.attachActiveTab(input.threadId, bounds);
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
        this.runtime.attachActiveTab(input.threadId, bounds);
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
    const runtime = this.runtime.ensureLiveRuntime(input.threadId, tab.id);
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.runtime.attachActiveTab(input.threadId, bounds);
    }
    runtime.webContents.openDevTools({ mode: "detach" });
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
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.runtime.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.webContents;
    const expectedUrl = normalizeUrlInput(tab.lastCommittedUrl ?? tab.url);
    const currentUrl = webContents.getURL();
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.runtime.attachActiveTab(input.threadId, bounds);
    }

    if (wasSuspended || currentUrl.length === 0 || currentUrl !== expectedUrl) {
      await this.runtime.loadTab(input.threadId, tab.id, { runtime });
    } else {
      this.runtime.queueRuntimeStateSync(input.threadId, tab.id);
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

  copyLink(input: BrowserTabInput): void {
    this.copyTabLink(input.threadId, input.tabId);
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
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.runtime.ensureLiveRuntime(input.threadId, tab.id);
    const webContents = runtime.webContents;
    const bounds = this.getVisibleBoundsForThread(input.threadId);
    if (bounds) {
      this.runtime.attachActiveTab(input.threadId, bounds);
    }

    if (wasSuspended) {
      await this.runtime.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.runtime.queueRuntimeStateSync(input.threadId, tab.id);
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
    const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.runtime.ensureLiveRuntime(input.threadId, tab.id);
    if (this.activeBounds && this.activeBoundsThreadId === input.threadId) {
      this.activateThread(input.threadId, this.activeBounds);
    }

    if (wasSuspended) {
      await this.runtime.loadTab(input.threadId, tab.id, { force: true, runtime });
    } else {
      this.runtime.queueRuntimeStateSync(input.threadId, tab.id);
    }

    if (!runtime.webContents.debugger.isAttached()) {
      runtime.webContents.debugger.attach("1.3");
    }
  }

  subscribeToCdpEvents(
    input: BrowserTabInput,
    listener: (event: BrowserUseCdpEvent) => void,
  ): () => void {
    const runtime = this.runtime.getRuntime(input.threadId, input.tabId);
    if (!runtime) {
      return () => {};
    }

    const handleMessage = (_event: Electron.Event, method: string, params?: unknown) => {
      listener({
        method,
        ...(params !== undefined ? { params } : {}),
      });
    };

    runtime.webContents.debugger.on("message", handleMessage);
    return () => {
      runtime.webContents.debugger.removeListener("message", handleMessage);
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
    this.runtime.attachActiveTab(threadId, bounds);
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
    let didChange = this.runtime.suspendInactiveTabs(threadId, activeTab?.id ?? null);

    // Only resume the visible tab. Waking every tab can fan out into several
    // Chromium renderer processes and background page activity at once.
    for (const tab of state.tabs) {
      if (tab.id !== activeTab?.id) {
        continue;
      }
      const wasSuspended = tab.status === SUSPENDED_TAB_STATUS;
      const runtime = this.runtime.ensureLiveRuntime(threadId, tab.id);
      if (wasSuspended) {
        void this.runtime.loadTab(threadId, tab.id, { force: true, runtime });
      } else {
        didChange = syncTabStateFromRuntime(state, tab, runtime.webContents) || didChange;
      }
    }

    didChange = syncThreadLastError(state) || didChange;
    if (didChange) {
      this.markThreadStateChanged(threadId);
      this.emitState(threadId);
    }
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
      this.runtime.destroyRuntime(threadId, tab.id);
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

  private bumpRuntimeCounter(counter: BrowserRuntimePerfCounter): void {
    this.perfCounters[counter] += 1;
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

  private copyTabLink(threadId: ThreadId, tabId: string): void {
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    const runtime = this.runtime.getRuntime(threadId, tabId);
    const liveUrl =
      runtime && !runtime.webContents.isDestroyed() ? runtime.webContents.getURL() : null;
    const url = resolveCopyableBrowserTabUrl(tab, liveUrl);
    if (!url) {
      return;
    }

    clipboard.writeText(url);
    const event: BrowserCopyLinkEvent = { threadId, url };
    for (const listener of this.copyLinkListeners) {
      listener(event);
    }
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
