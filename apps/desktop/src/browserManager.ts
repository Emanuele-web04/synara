import * as Crypto from "node:crypto";

import { BrowserWindow, shell, WebContentsView } from "electron";
import type {
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
const BROWSER_SESSION_PARTITION = "persist:t3code-browser";
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

function createBrowserTab(url = ABOUT_BLANK_URL): BrowserTabState {
  return {
    id: Crypto.randomUUID(),
    url,
    title: defaultTitleForUrl(url),
    status: "suspended",
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

export class DesktopBrowserManager {
  private window: BrowserWindow | null = null;
  private activeThreadId: ThreadId | null = null;
  private activeBounds: BrowserPanelBounds | null = null;
  private attachedRuntimeKey: string | null = null;
  private readonly states = new Map<ThreadId, ThreadBrowserState>();
  private readonly runtimes = new Map<string, LiveTabRuntime>();
  private readonly listeners = new Set<BrowserStateListener>();
  private readonly suspendTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    if (window) {
      if (this.activeThreadId && this.activeBounds) {
        this.attachActiveTab(this.activeThreadId, this.activeBounds);
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
    this.detachAttachedRuntime();
    this.destroyAllRuntimes();
    this.listeners.clear();
    this.states.clear();
    this.window = null;
    this.activeThreadId = null;
    this.activeBounds = null;
  }

  open(input: BrowserOpenInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId, input.initialUrl);
    state.open = true;
    syncThreadLastError(state);

    if (
      this.activeBounds &&
      (this.activeThreadId === null || this.activeThreadId === input.threadId)
    ) {
      this.activateThread(input.threadId, this.activeBounds);
    }

    this.emitState(input.threadId);
    return cloneThreadState(state);
  }

  close(input: BrowserThreadInput): ThreadBrowserState {
    this.clearSuspendTimer(input.threadId);

    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }

    this.destroyThreadRuntimes(input.threadId);

    const state = this.getOrCreateState(input.threadId);
    state.open = false;
    state.activeTabId = null;
    state.tabs = [];
    state.lastError = null;
    this.emitState(input.threadId);
    return cloneThreadState(state);
  }

  hide(input: BrowserThreadInput): void {
    const state = this.states.get(input.threadId);
    if (!state?.open) {
      return;
    }

    if (this.activeThreadId === input.threadId) {
      this.detachAttachedRuntime();
      this.activeThreadId = null;
    }

    this.scheduleThreadSuspend(input.threadId);
  }

  getState(input: BrowserThreadInput): ThreadBrowserState {
    return cloneThreadState(this.getOrCreateState(input.threadId));
  }

  setPanelBounds(input: BrowserSetPanelBoundsInput): ThreadBrowserState {
    const state = this.getOrCreateState(input.threadId);
    const nextBounds = normalizeBounds(input.bounds);
    this.activeBounds = nextBounds;

    if (!state.open || nextBounds === null) {
      if (this.activeThreadId === input.threadId) {
        this.detachAttachedRuntime();
        this.activeThreadId = null;
        this.scheduleThreadSuspend(input.threadId);
      }
      return cloneThreadState(state);
    }

    this.activateThread(input.threadId, nextBounds);
    return cloneThreadState(state);
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

    if (this.activeThreadId === input.threadId) {
      // Load the target tab directly so we don't clobber its pending URL with a
      // thread-wide runtime sync from the old live page state.
      const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
      this.clearSuspendTimer(input.threadId);
      if (state.activeTabId === tab.id && this.activeBounds) {
        this.attachRuntime(runtime, this.activeBounds);
      }
      void this.loadTab(input.threadId, tab.id, { force: true, runtime });
    }

    this.emitState(input.threadId);
    return cloneThreadState(state);
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
    return cloneThreadState(state);
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
      this.ensureLiveRuntime(input.threadId, tab.id);
      void this.loadTab(input.threadId, tab.id, { force: true });
      if (state.activeTabId === tab.id && this.activeBounds) {
        this.attachActiveTab(input.threadId, this.activeBounds);
      }
    } else {
      tab.status = "suspended";
    }

    syncThreadLastError(state);
    this.emitState(input.threadId);
    return cloneThreadState(state);
  }

  closeTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const nextTabs = state.tabs.filter((tab) => tab.id !== input.tabId);
    if (nextTabs.length === state.tabs.length) {
      return cloneThreadState(state);
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
      this.emitState(input.threadId);
      return cloneThreadState(state);
    }

    if (!state.activeTabId || state.activeTabId === input.tabId) {
      state.activeTabId = nextTabs[Math.max(0, nextTabs.length - 1)]?.id ?? null;
    }

    if (this.activeThreadId === input.threadId && this.activeBounds) {
      this.attachActiveTab(input.threadId, this.activeBounds);
    }

    syncThreadLastError(state);
    this.emitState(input.threadId);
    return cloneThreadState(state);
  }

  selectTab(input: BrowserTabInput): ThreadBrowserState {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.emitState(input.threadId);
    }

    if (this.activeThreadId === input.threadId) {
      this.resumeThread(input.threadId);
      if (this.activeBounds) {
        this.attachActiveTab(input.threadId, this.activeBounds);
      }
    }

    return cloneThreadState(state);
  }

  openDevTools(input: BrowserTabInput): void {
    const state = this.ensureWorkspace(input.threadId);
    const tab = this.resolveTab(state, input.tabId);
    if (state.activeTabId !== tab.id) {
      state.activeTabId = tab.id;
      syncThreadLastError(state);
      this.emitState(input.threadId);
    }

    this.resumeThread(input.threadId);
    const runtime = this.ensureLiveRuntime(input.threadId, tab.id);
    if (this.activeBounds) {
      this.attachActiveTab(input.threadId, this.activeBounds);
    }
    runtime.view.webContents.openDevTools({ mode: "detach" });
  }

  private activateThread(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    if (this.activeThreadId && this.activeThreadId !== threadId) {
      this.scheduleThreadSuspend(this.activeThreadId);
    }

    this.activeThreadId = threadId;
    this.activeBounds = bounds;
    this.resumeThread(threadId);
    this.attachActiveTab(threadId, bounds);
  }

  private resumeThread(threadId: ThreadId): void {
    const state = this.ensureWorkspace(threadId);
    if (!state.open) {
      return;
    }

    this.clearSuspendTimer(threadId);

    for (const tab of state.tabs) {
      const runtime = this.ensureLiveRuntime(threadId, tab.id);
      if (tab.status === "suspended") {
        void this.loadTab(threadId, tab.id, { force: true, runtime });
      } else {
        syncTabStateFromRuntime(state, tab, runtime.view.webContents);
      }
    }

    syncThreadLastError(state);
    this.emitState(threadId);
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

    for (const tab of state.tabs) {
      this.destroyRuntime(threadId, tab.id);
      tab.status = "suspended";
      tab.isLoading = false;
      tab.canGoBack = false;
      tab.canGoForward = false;
    }

    syncThreadLastError(state);
    this.emitState(threadId);
  }

  private clearSuspendTimer(threadId: ThreadId): void {
    const existing = this.suspendTimers.get(threadId);
    if (!existing) {
      return;
    }
    clearTimeout(existing);
    this.suspendTimers.delete(threadId);
  }

  private attachActiveTab(threadId: ThreadId, bounds: BrowserPanelBounds): void {
    const state = this.ensureWorkspace(threadId);
    const activeTab = this.getActiveTab(state);
    if (!activeTab) {
      return;
    }

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

    if (this.attachedRuntimeKey === runtime.key) {
      runtime.view.setBounds(bounds);
      return;
    }

    this.detachAttachedRuntime();
    window.contentView.addChildView(runtime.view);
    runtime.view.setBounds(bounds);
    this.attachedRuntimeKey = runtime.key;
  }

  private detachAttachedRuntime(): void {
    if (!this.window || !this.attachedRuntimeKey) {
      this.attachedRuntimeKey = null;
      return;
    }

    const runtime = this.runtimes.get(this.attachedRuntimeKey);
    if (runtime) {
      this.window.contentView.removeChildView(runtime.view);
    }
    this.attachedRuntimeKey = null;
  }

  private ensureLiveRuntime(threadId: ThreadId, tabId: string): LiveTabRuntime {
    const key = buildRuntimeKey(threadId, tabId);
    const existing = this.runtimes.get(key);
    if (existing) {
      return existing;
    }

    const runtime = this.createLiveRuntime(threadId, tabId);
    this.runtimes.set(key, runtime);
    const state = this.ensureWorkspace(threadId);
    const tab = this.getTab(state, tabId);
    if (tab) {
      tab.status = "live";
      tab.lastError = null;
      syncThreadLastError(state);
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
        if (this.activeThreadId === threadId && this.activeBounds) {
          this.attachActiveTab(threadId, this.activeBounds);
        }
        return { action: "deny" };
      }

      void shell.openExternal(url);
      return { action: "deny" };
    });

    webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      this.syncRuntimeState(threadId, tabId);
    });
    webContents.on("page-favicon-updated", (_event, faviconUrls) => {
      this.syncRuntimeState(threadId, tabId, faviconUrls);
    });
    webContents.on("did-start-loading", () => {
      this.syncRuntimeState(threadId, tabId);
    });
    webContents.on("did-stop-loading", () => {
      this.syncRuntimeState(threadId, tabId);
    });
    webContents.on("did-navigate", () => {
      this.syncRuntimeState(threadId, tabId);
    });
    webContents.on("did-navigate-in-page", () => {
      this.syncRuntimeState(threadId, tabId);
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
        this.emitState(threadId);
      }
      if (this.activeThreadId === threadId && this.activeBounds) {
        this.attachActiveTab(threadId, this.activeBounds);
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
      this.syncRuntimeState(threadId, tabId);
      return;
    }

    tab.url = nextUrl;
    tab.status = "live";
    tab.isLoading = true;
    tab.lastError = null;
    syncThreadLastError(state);
    this.emitState(threadId);

    try {
      await webContents.loadURL(nextUrl);
      this.syncRuntimeState(threadId, tabId);
    } catch (error) {
      if (isAbortedNavigationError(error)) {
        this.syncRuntimeState(threadId, tabId);
        return;
      }

      tab.isLoading = false;
      tab.lastError = "Couldn't open this page.";
      syncThreadLastError(state);
      this.emitState(threadId);
    }
  }

  private syncRuntimeState(threadId: ThreadId, tabId: string, faviconUrls?: string[]): void {
    const state = this.states.get(threadId);
    const tab = state ? this.getTab(state, tabId) : null;
    const runtime = this.runtimes.get(buildRuntimeKey(threadId, tabId));
    if (!state || !tab || !runtime) {
      return;
    }

    syncTabStateFromRuntime(state, tab, runtime.view.webContents, faviconUrls);
    syncThreadLastError(state);
    this.emitState(threadId);
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
    return initial;
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
    const state = cloneThreadState(this.getOrCreateState(threadId));
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function syncTabStateFromRuntime(
  state: ThreadBrowserState,
  tab: BrowserTabState,
  webContents: WebContentsView["webContents"],
  faviconUrls?: string[],
): void {
  const currentUrl = webContents.getURL();
  const nextUrl = currentUrl || tab.url;
  const nextTitle = webContents.getTitle();
  tab.status = "live";
  tab.url = nextUrl;
  tab.title = !nextTitle || nextTitle === ABOUT_BLANK_URL ? defaultTitleForUrl(nextUrl) : nextTitle;
  tab.isLoading = webContents.isLoading();
  tab.canGoBack = webContents.canGoBack();
  tab.canGoForward = webContents.canGoForward();
  tab.lastCommittedUrl = currentUrl || tab.lastCommittedUrl;
  if (faviconUrls) {
    tab.faviconUrl = faviconUrls[0] ?? tab.faviconUrl;
  }
  if (tab.lastError && !tab.isLoading) {
    tab.lastError = null;
  }
  syncThreadLastError(state);
}

function syncThreadLastError(state: ThreadBrowserState): void {
  const activeTab =
    (state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : undefined) ??
    state.tabs[0];
  state.lastError = activeTab?.lastError ?? null;
}
