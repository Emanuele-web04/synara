// FILE: browserManager.runtime.ts
// Purpose: Electron-bound runtime layer for the desktop browser: WebContentsView/webContents
//   wiring, view attach/detach, runtime lifecycle, inactive-tab suspend scheduling, CDP.
// Layer: Desktop runtime manager (runtime controller)
// Exports: BrowserRuntimeController, BrowserRuntimeDeps, BrowserRuntimeCollaborators

import type { BrowserWindow, WebContents, WebContentsView } from "electron";
import type {
  BrowserPanelBounds,
  BrowserTabState,
  ThreadBrowserState,
  ThreadId,
} from "@t3tools/contracts";
import { isBrowserCopyLinkChord } from "@t3tools/shared/browserShortcuts";

import {
  ABOUT_BLANK_URL,
  BROWSER_ERROR_ABORTED,
  BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS,
  BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS,
  BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD,
  BROWSER_SESSION_PARTITION,
  LIVE_TAB_STATUS,
  SUSPENDED_TAB_STATUS,
} from "./browserManager.types";
import type {
  LiveTabRuntime,
  NativeBrowserViewVisibility,
  PendingRuntimeSync,
} from "./browserManager.types";
import {
  browserBoundsSignature,
  buildRuntimeKey,
  defaultTitleForUrl,
  isAbortedNavigationError,
  mapBrowserLoadError,
  normalizeUrlInput,
  suspendTabState,
  syncTabStateFromRuntime,
  syncThreadLastError,
} from "./browserManager.helpers";

export interface BrowserRuntimeCollaborators {
  WebContentsView: typeof WebContentsView;
  shell: { openExternal: (url: string) => Promise<void> };
}

// Hooks back into the thread/tab state model owned by DesktopBrowserManager. The
// controller never reaches into the manager's maps directly; it reads/mutates
// through these so the stateful core and the electron-bound runtime stay separable.
export interface BrowserRuntimeDeps {
  getWindow: () => BrowserWindow | null;
  getActiveThreadId: () => ThreadId | null;
  getState: (threadId: ThreadId) => ThreadBrowserState | null;
  ensureWorkspace: (threadId: ThreadId) => ThreadBrowserState;
  getTab: (state: ThreadBrowserState, tabId: string) => BrowserTabState | null;
  getActiveTab: (state: ThreadBrowserState) => BrowserTabState | null;
  getVisibleBoundsForThread: (threadId: ThreadId) => BrowserPanelBounds | null;
  markThreadStateChanged: (threadId: ThreadId) => void;
  emitState: (threadId: ThreadId) => void;
  openNewTab: (input: { threadId: ThreadId; url: string; activate: boolean }) => void;
  copyTabLink: (threadId: ThreadId, tabId: string) => void;
  incrementCounter: (counter: BrowserRuntimePerfCounter) => void;
}

export type BrowserRuntimePerfCounter =
  | "syncRuntimeStateCalls"
  | "runtimeSyncQueueFlushes"
  | "inactiveTabSuspendScheduled"
  | "inactiveTabSuspendCancelled"
  | "inactiveTabBudgetEvictions";

export class BrowserRuntimeController {
  private attachedRuntimeKey: string | null = null;
  private attachedBoundsSignature: string | null = null;
  private readonly runtimes = new Map<string, LiveTabRuntime>();
  private readonly runtimeLastActiveAtByKey = new Map<string, number>();
  private readonly pendingRuntimeSyncs = new Map<string, PendingRuntimeSync>();
  private readonly tabSuspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private runtimeSyncFlushScheduled = false;

  constructor(
    private readonly deps: BrowserRuntimeDeps,
    private readonly electron: BrowserRuntimeCollaborators,
  ) {}

  getRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime | null {
    return this.runtimes.get(buildRuntimeKey(threadId, tabId)) ?? null;
  }

  hasRuntime(threadId: ThreadId, tabId: string): boolean {
    return this.runtimes.has(buildRuntimeKey(threadId, tabId));
  }

  countThreadRuntimes(threadId: ThreadId): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.threadId === threadId) {
        count += 1;
      }
    }
    return count;
  }

  resetAttachedPointers(): void {
    this.attachedRuntimeKey = null;
    this.attachedBoundsSignature = null;
  }

  getAttachedRuntimeKey(): string | null {
    return this.attachedRuntimeKey;
  }

  getAttachedBoundsSignature(): string | null {
    return this.attachedBoundsSignature;
  }

  getTrackedProcessIds(): number[] {
    const processIds = new Set<number>();
    for (const runtime of this.runtimes.values()) {
      const webContents = runtime.webContents;
      if (webContents.isDestroyed()) {
        continue;
      }
      processIds.add(webContents.getProcessId());
    }
    return [...processIds];
  }

  countWarmInactiveRuntimes(): number {
    let count = 0;
    for (const [key] of this.tabSuspendTimers) {
      if (this.runtimes.has(key)) {
        count += 1;
      }
    }
    return count;
  }

  findRendererRuntimeByWebContentsId(webContentsId: number): LiveTabRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.ownsWebContents && runtime.webContents.id === webContentsId) {
        return runtime;
      }
    }
    return null;
  }

  clearAllTabSuspendTimers(): void {
    for (const timer of this.tabSuspendTimers.values()) {
      clearTimeout(timer);
    }
    this.tabSuspendTimers.clear();
  }

  clearRuntimeBookkeeping(): void {
    this.pendingRuntimeSyncs.clear();
    this.runtimeLastActiveAtByKey.clear();
    this.runtimeSyncFlushScheduled = false;
  }

  adoptRendererRuntime(threadId: ThreadId, tabId: string, webContents: WebContents): void {
    const key = buildRuntimeKey(threadId, tabId);
    const runtime: LiveTabRuntime = {
      key,
      threadId,
      tabId,
      webContents,
      view: null,
      ownsWebContents: false,
      listenerDisposers: [],
    };
    this.configureRuntimeWebContents(runtime);
    this.runtimes.set(key, runtime);
  }

  detachRendererRuntime(threadId: ThreadId, tabId: string, webContentsId: number): boolean {
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!runtime || runtime.ownsWebContents || runtime.webContents.id !== webContentsId) {
      return false;
    }

    this.destroyRuntime(threadId, tabId);
    return true;
  }

  attachActiveTab(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const state = this.deps.ensureWorkspace(threadId);
    const activeTab = this.deps.getActiveTab(state);
    if (!activeTab) {
      return;
    }

    this.suspendInactiveTabs(threadId, activeTab.id);
    const wasSuspended = activeTab.status === SUSPENDED_TAB_STATUS;
    const runtime = this.ensureLiveRuntime(threadId, activeTab.id);
    this.attachRuntime(runtime, bounds);
    if (wasSuspended) {
      void this.loadTab(threadId, activeTab.id, { force: true, runtime });
    } else {
      this.syncRuntimeState(threadId, activeTab.id);
    }
  }

  attachRuntime(runtime: LiveTabRuntime, bounds: BrowserPanelBounds): void {
    const window = this.deps.getWindow();
    if (!window) {
      return;
    }

    const nextBoundsSignature = browserBoundsSignature(bounds);
    this.runtimeLastActiveAtByKey.set(runtime.key, Date.now());
    // Renderer-owned <webview> runtimes are already visible in React; keep any
    // old native view detached so it cannot cover the real browser surface.
    if (!runtime.ownsWebContents) {
      if (this.attachedRuntimeKey && this.attachedRuntimeKey !== runtime.key) {
        this.detachAttachedRuntime();
      }
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      return;
    }
    if (!runtime.view) {
      this.attachedRuntimeKey = runtime.key;
      this.attachedBoundsSignature = nextBoundsSignature;
      return;
    }
    if (this.attachedRuntimeKey === runtime.key) {
      this.setRuntimeViewHidden(runtime, false);
      this.bringRuntimeViewToFront(runtime);
      if (this.attachedBoundsSignature === nextBoundsSignature) {
        return;
      }
      runtime.view.setBounds(bounds);
      this.attachedBoundsSignature = nextBoundsSignature;
      return;
    }

    this.detachAttachedRuntime();
    this.setRuntimeViewHidden(runtime, false);
    this.bringRuntimeViewToFront(runtime);
    runtime.view.setBounds(bounds);
    this.attachedRuntimeKey = runtime.key;
    this.attachedBoundsSignature = nextBoundsSignature;
  }

  private bringRuntimeViewToFront(runtime: LiveTabRuntime): void {
    const window = this.deps.getWindow();
    if (!window || !runtime.view) {
      return;
    }

    try {
      window.contentView.removeChildView(runtime.view);
    } catch {
      // Electron throws when the view is not attached yet; adding it below is the desired state.
    }
    window.contentView.addChildView(runtime.view);
  }

  detachAttachedRuntime(): void {
    const window = this.deps.getWindow();
    if (!window || !this.attachedRuntimeKey) {
      this.attachedRuntimeKey = null;
      this.attachedBoundsSignature = null;
      return;
    }

    const runtime = this.runtimes.get(this.attachedRuntimeKey);
    if (runtime?.view) {
      this.setRuntimeViewHidden(runtime, true);
      window.contentView.removeChildView(runtime.view);
    }
    this.attachedRuntimeKey = null;
    this.attachedBoundsSignature = null;
  }

  private setRuntimeViewHidden(runtime: LiveTabRuntime, hidden: boolean): void {
    if (!runtime.view) {
      return;
    }
    const nativeView = runtime.view as typeof runtime.view & NativeBrowserViewVisibility;
    nativeView.setVisible?.(!hidden);
    if (hidden) {
      runtime.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  ensureLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const key = buildRuntimeKey(threadId, tabId);
    this.clearTabSuspendTimer(threadId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) {
      if (existing.webContents.isDestroyed()) {
        this.destroyRuntime(threadId, tabId);
      } else {
        return existing;
      }
    }

    const runtime = this.createLiveRuntime(threadId, tabId);
    this.runtimes.set(key, runtime);
    const state = this.deps.ensureWorkspace(threadId);
    const tab = this.deps.getTab(state, tabId);
    if (tab) {
      const didChange = tab.status !== "live" || tab.lastError !== null;
      tab.status = "live";
      tab.lastError = null;
      syncThreadLastError(state);
      if (didChange) {
        this.deps.markThreadStateChanged(threadId);
      }
    }
    return runtime;
  }

  private createLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const view = new this.electron.WebContentsView({
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
      webContents: view.webContents,
      view,
      ownsWebContents: true,
      listenerDisposers: [],
    };
    this.configureRuntimeWebContents(runtime);
    return runtime;
  }

  private configureRuntimeWebContents(runtime: LiveTabRuntime): void {
    const { threadId, tabId, webContents } = runtime;

    webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://") || url === ABOUT_BLANK_URL) {
        this.deps.openNewTab({
          threadId,
          url,
          activate: true,
        });
        const bounds = this.deps.getVisibleBoundsForThread(threadId);
        if (this.deps.getActiveThreadId() === threadId && bounds) {
          this.attachActiveTab(threadId, bounds);
        }
        return { action: "deny" };
      }

      void this.electron.shell.openExternal(url);
      return { action: "deny" };
    });

    const beforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== "keyDown") {
        return;
      }
      const matches = isBrowserCopyLinkChord(
        {
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
          key: input.key,
        },
        process.platform === "darwin",
      );
      if (!matches) {
        return;
      }

      event.preventDefault();
      this.deps.copyTabLink(threadId, tabId);
    };
    webContents.on("before-input-event", beforeInputEvent);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("before-input-event", beforeInputEvent);
    });

    const pageTitleUpdated = (event: Electron.Event) => {
      event.preventDefault();
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("page-title-updated", pageTitleUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-title-updated", pageTitleUpdated);
    });

    const pageFaviconUpdated = (_event: Electron.Event, faviconUrls: string[]) => {
      this.queueRuntimeStateSync(threadId, tabId, faviconUrls);
    };
    webContents.on("page-favicon-updated", pageFaviconUpdated);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("page-favicon-updated", pageFaviconUpdated);
    });

    const didStartLoading = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-start-loading", didStartLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-start-loading", didStartLoading);
    });

    const didStopLoading = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-stop-loading", didStopLoading);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-stop-loading", didStopLoading);
    });

    const didNavigate = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-navigate", didNavigate);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate", didNavigate);
    });

    const didNavigateInPage = () => {
      this.queueRuntimeStateSync(threadId, tabId);
    };
    webContents.on("did-navigate-in-page", didNavigateInPage);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-navigate-in-page", didNavigateInPage);
    });

    const didFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      _errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || errorCode === BROWSER_ERROR_ABORTED) {
        return;
      }

      const state = this.deps.getState(threadId);
      const tab = state ? this.deps.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      tab.url = validatedURL || tab.url;
      tab.title = defaultTitleForUrl(tab.url);
      tab.isLoading = false;
      tab.lastError = mapBrowserLoadError(errorCode);
      syncThreadLastError(state);
      this.deps.markThreadStateChanged(threadId);
      this.deps.emitState(threadId);
    };
    webContents.on("did-fail-load", didFailLoad);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("did-fail-load", didFailLoad);
    });

    const renderProcessGone = () => {
      const state = this.deps.getState(threadId);
      const tab = state ? this.deps.getTab(state, tabId) : null;
      this.destroyRuntime(threadId, tabId);
      if (state && tab) {
        tab.status = "suspended";
        tab.isLoading = false;
        tab.lastError = "This tab stopped unexpectedly.";
        syncThreadLastError(state);
        this.deps.markThreadStateChanged(threadId);
        this.deps.emitState(threadId);
      }
      const bounds = this.deps.getVisibleBoundsForThread(threadId);
      if (this.deps.getActiveThreadId() === threadId && bounds) {
        this.attachActiveTab(threadId, bounds);
      }
    };
    webContents.on("render-process-gone", renderProcessGone);
    runtime.listenerDisposers.push(() => {
      webContents.removeListener("render-process-gone", renderProcessGone);
    });
  }

  async loadTab(
    threadId: ThreadId,
    tabId: string,
    options: { force?: boolean; runtime?: LiveTabRuntime } = {},
  ): Promise<void> {
    const state = this.deps.ensureWorkspace(threadId);
    const tab = this.deps.getTab(state, tabId);
    if (!tab) {
      return;
    }

    const runtime = options.runtime ?? this.ensureLiveRuntime(threadId, tabId);
    const webContents = runtime.webContents;
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
    this.deps.markThreadStateChanged(threadId);
    this.deps.emitState(threadId);

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
      this.deps.markThreadStateChanged(threadId);
      this.deps.emitState(threadId);
    }
  }

  syncRuntimeState(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    this.deps.incrementCounter("syncRuntimeStateCalls");
    const state = this.deps.getState(threadId);
    const tab = state ? this.deps.getTab(state, tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!state || !tab || !runtime) {
      return;
    }

    const didChange = syncTabStateFromRuntime(state, tab, runtime.webContents, faviconUrls);
    const nextDidChange = syncThreadLastError(state) || didChange;
    if (nextDidChange) {
      this.deps.markThreadStateChanged(threadId);
      this.deps.emitState(threadId);
    }
  }

  queueRuntimeStateSync(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
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

      this.deps.incrementCounter("runtimeSyncQueueFlushes");
      const pendingSyncs = [...this.pendingRuntimeSyncs.values()];
      this.pendingRuntimeSyncs.clear();
      for (const pendingSync of pendingSyncs) {
        this.syncRuntimeState(pendingSync.threadId, pendingSync.tabId, pendingSync.faviconUrls);
      }
    });
  }

  destroyThreadRuntimes(threadId: ThreadId): void {
    const state = this.deps.getState(threadId);
    if (!state) {
      return;
    }

    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
    }
  }

  destroyAllRuntimes(): void {
    for (const runtime of this.runtimes.values()) {
      this.destroyRuntime(runtime.threadId, runtime.tabId);
    }
  }

  destroyRuntime(threadId: ThreadId, tabId: string): void {
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
    const webContents = runtime.webContents;
    for (const disposeListener of runtime.listenerDisposers.splice(0)) {
      disposeListener();
    }
    if (!webContents.isDestroyed()) {
      if (webContents.debugger.isAttached()) {
        try {
          webContents.debugger.detach();
        } catch {
          // The runtime is being torn down anyway; ignore stale-debugger cleanup noise.
        }
      }
      if (runtime.ownsWebContents) {
        webContents.close({ waitForBeforeUnload: false });
      }
    }
  }

  suspendInactiveTabs(threadId: ThreadId, activeTabId: string | null): boolean {
    const state = this.deps.getState(threadId);
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

        this.deps.incrementCounter("inactiveTabBudgetEvictions");
        this.destroyRuntime(threadId, tab.id);
        didChange = suspendTabState(tab) || didChange;
        continue;
      }

      didChange = suspendTabState(tab) || didChange;
    }

    return didChange;
  }

  private scheduleInactiveTabSuspend(threadId: ThreadId, tabId: string): void {
    const key = buildRuntimeKey(threadId, tabId);
    if (this.tabSuspendTimers.has(key)) {
      return;
    }

    this.deps.incrementCounter("inactiveTabSuspendScheduled");
    const delayMs = this.resolveInactiveTabSuspendDelay(threadId);
    const timer = setTimeout(() => {
      this.tabSuspendTimers.delete(key);
      const state = this.deps.getState(threadId);
      const tab = state ? this.deps.getTab(state, tabId) : null;
      if (!state || !tab) {
        return;
      }

      this.destroyRuntime(threadId, tabId);
      const didChange = suspendTabState(tab) || syncThreadLastError(state);
      if (didChange) {
        this.deps.markThreadStateChanged(threadId);
        this.deps.emitState(threadId);
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
    this.deps.incrementCounter("inactiveTabSuspendCancelled");
  }

  private resolveInactiveTabSuspendDelay(threadId: ThreadId): number {
    const threadRuntimeCount = this.countThreadRuntimes(threadId);
    if (
      threadRuntimeCount > BROWSER_MAX_WARM_INACTIVE_RUNTIMES_PER_THREAD + 1 ||
      this.runtimes.size > 4
    ) {
      return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_PRESSURED_MS;
    }

    return BROWSER_INACTIVE_TAB_SUSPEND_DELAY_MS;
  }
}

export { LIVE_TAB_STATUS, SUSPENDED_TAB_STATUS };
