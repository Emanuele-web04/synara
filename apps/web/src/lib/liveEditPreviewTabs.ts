import type {
  BrowserTabState,
  NativeApi,
  ProjectId,
  ThreadBrowserState,
  ThreadId,
} from "@t3tools/contracts";

export interface LiveEditPreviewTabTarget {
  threadId: ThreadId;
  cwd: string;
  projectId?: ProjectId | null;
  targetCwd?: string | null;
  url: string;
}

interface LiveEditPreviewTabRecord {
  threadId: ThreadId;
  scopeKey: string;
  cwd: string;
  targetCwd: string | null;
  projectId: ProjectId | null;
  tabId: string;
  url: string;
}

export interface LiveEditPreviewCloseTarget {
  threadId?: ThreadId;
  cwd?: string | null;
  projectId?: ProjectId | null;
  urls?: readonly string[];
  fallbackThreadIds?: readonly ThreadId[];
  closeLocalPreviewTabs?: boolean;
}

const previewTabRecordsByKey = new Map<string, LiveEditPreviewTabRecord>();

function normalizedScopePath(target: LiveEditPreviewTabTarget): string {
  return (target.targetCwd ?? target.cwd).trim();
}

export function liveEditPreviewScopeKey(target: LiveEditPreviewTabTarget): string {
  return `${target.projectId ?? "projectless"}:${normalizedScopePath(target)}`;
}

function liveEditPreviewRecordKey(target: Pick<LiveEditPreviewTabTarget, "threadId"> & {
  projectId?: ProjectId | null;
  targetCwd?: string | null;
  cwd: string;
}): string {
  return `${target.threadId}:${liveEditPreviewScopeKey({
    threadId: target.threadId,
    cwd: target.cwd,
    projectId: target.projectId,
    targetCwd: target.targetCwd,
    url: "",
  })}`;
}

export function liveEditPreviewRouteKey(target: LiveEditPreviewTabTarget): string {
  return `${liveEditPreviewRecordKey(target)}:${target.url.trim()}`;
}

function upsertPreviewTabRecord(target: LiveEditPreviewTabTarget, tabId: string): void {
  previewTabRecordsByKey.set(liveEditPreviewRecordKey(target), {
    threadId: target.threadId,
    scopeKey: liveEditPreviewScopeKey(target),
    cwd: target.cwd.trim(),
    targetCwd: target.targetCwd?.trim() || null,
    projectId: target.projectId ?? null,
    tabId,
    url: target.url.trim(),
  });
}

function tabUrl(tab: BrowserTabState): string {
  return (tab.lastCommittedUrl ?? tab.url).trim();
}

function previewUrlKey(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const pathname =
      url.pathname === "/"
        ? ""
        : url.pathname.endsWith("/")
          ? url.pathname.slice(0, -1)
          : url.pathname;
    return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
  } catch {
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
}

function isLocalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    return (
      url.port.length > 0 &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "0.0.0.0" ||
        hostname === "::1")
    );
  } catch {
    return false;
  }
}

function tabMatchesUrl(tab: BrowserTabState, url: string): boolean {
  const targetUrl = previewUrlKey(url);
  return previewUrlKey(tab.url) === targetUrl || previewUrlKey(tabUrl(tab)) === targetUrl;
}

function isReusableBlankTab(tab: BrowserTabState): boolean {
  return (
    tab.url === "about:blank" && (tab.lastCommittedUrl === null || tab.lastCommittedUrl === "")
  );
}

function activeTab(state: ThreadBrowserState): BrowserTabState | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0] ?? null;
}

async function selectAndNavigatePreviewTab(
  api: NativeApi,
  state: ThreadBrowserState,
  target: LiveEditPreviewTabTarget,
  tab: BrowserTabState,
): Promise<ThreadBrowserState> {
  let nextState = await api.browser.navigate({
    threadId: target.threadId,
    tabId: tab.id,
    url: target.url,
  });
  if (nextState.activeTabId !== tab.id) {
    nextState = await api.browser.selectTab({
      threadId: target.threadId,
      tabId: tab.id,
    });
  }
  upsertPreviewTabRecord(target, tab.id);
  return nextState;
}

export async function openLiveEditPreviewTab(
  api: NativeApi,
  target: LiveEditPreviewTabTarget,
): Promise<ThreadBrowserState> {
  const recordKey = liveEditPreviewRecordKey(target);
  const initialState = await api.browser.open({ threadId: target.threadId });
  const mappedRecord = previewTabRecordsByKey.get(recordKey) ?? null;
  const mappedTab = mappedRecord
    ? initialState.tabs.find((tab) => tab.id === mappedRecord.tabId) ?? null
    : null;
  if (mappedTab) {
    return selectAndNavigatePreviewTab(api, initialState, target, mappedTab);
  }
  if (mappedRecord) {
    previewTabRecordsByKey.delete(recordKey);
  }

  const currentActiveTab = activeTab(initialState);
  const reusableTab =
    currentActiveTab && isReusableBlankTab(currentActiveTab)
      ? currentActiveTab
      : initialState.tabs.length === 1 && isReusableBlankTab(initialState.tabs[0]!)
        ? initialState.tabs[0]!
        : null;
  if (reusableTab) {
    return selectAndNavigatePreviewTab(api, initialState, target, reusableTab);
  }

  const nextState = await api.browser.newTab({
    threadId: target.threadId,
    url: target.url,
    activate: true,
  });
  if (nextState.activeTabId) {
    upsertPreviewTabRecord(target, nextState.activeTabId);
  }
  return nextState;
}

function matchesCloseTarget(
  record: LiveEditPreviewTabRecord,
  target: LiveEditPreviewCloseTarget,
): boolean {
  if (target.threadId && record.threadId !== target.threadId) {
    return false;
  }
  if (target.projectId && record.projectId !== target.projectId) {
    return false;
  }
  const cwd = target.cwd?.trim();
  if (cwd && record.cwd !== cwd) {
    return false;
  }
  return true;
}

export function getLiveEditPreviewThreadIds(target: LiveEditPreviewCloseTarget = {}): ThreadId[] {
  return uniqueThreadIds(
    Array.from(previewTabRecordsByKey.values())
      .filter((record) => matchesCloseTarget(record, target))
      .map((record) => record.threadId),
  );
}

export function hasLiveEditPreviewForThread(threadId: ThreadId): boolean {
  return Array.from(previewTabRecordsByKey.values()).some((record) => record.threadId === threadId);
}

function uniqueThreadIds(values: readonly ThreadId[]): ThreadId[] {
  return Array.from(new Set(values));
}

async function closeMatchingUrlTabs(
  api: NativeApi,
  threadIds: readonly ThreadId[],
  urls: readonly string[],
  closedTabKeys: Set<string>,
  browserStates?: readonly ThreadBrowserState[],
): Promise<ThreadBrowserState[]> {
  if (urls.length === 0 || (threadIds.length === 0 && !browserStates)) {
    return [];
  }
  const urlKeys = new Set(urls.map(previewUrlKey));
  const states: ThreadBrowserState[] = [];
  const statesToScan =
    browserStates ??
    (await Promise.all(
      uniqueThreadIds(threadIds).map((threadId) =>
        api.browser.getState({ threadId }).catch(() => null),
      ),
    ));
  for (const state of statesToScan) {
    if (!state) {
      continue;
    }
    const tabs = state.tabs.filter(
      (tab) => urlKeys.has(previewUrlKey(tab.url)) || urlKeys.has(previewUrlKey(tabUrl(tab))),
    );
    for (const tab of tabs) {
      const tabKey = `${state.threadId}:${tab.id}`;
      if (closedTabKeys.has(tabKey)) {
        continue;
      }
      closedTabKeys.add(tabKey);
      const closedState = await api.browser
        .closeTab({ threadId: state.threadId, tabId: tab.id })
        .catch(() => null);
      if (closedState) {
        states.push(closedState);
      }
    }
  }
  return states;
}

async function closeLocalPreviewTabs(
  api: NativeApi,
  threadIds: readonly ThreadId[] = [],
  closedTabKeys: Set<string>,
  browserStates?: readonly ThreadBrowserState[],
): Promise<ThreadBrowserState[]> {
  const states: ThreadBrowserState[] = [];
  const statesToScan =
    browserStates ??
    (await Promise.all(
      uniqueThreadIds(threadIds).map((threadId) =>
        api.browser.getState({ threadId }).catch(() => null),
      ),
    ));
  for (const state of statesToScan) {
    if (!state) {
      continue;
    }
    const tabs = state.tabs.filter(
      (tab) => isLocalPreviewUrl(tab.url) || isLocalPreviewUrl(tabUrl(tab)),
    );
    for (const tab of tabs) {
      const tabKey = `${state.threadId}:${tab.id}`;
      if (closedTabKeys.has(tabKey)) {
        continue;
      }
      closedTabKeys.add(tabKey);
      const closedState = await api.browser
        .closeTab({ threadId: state.threadId, tabId: tab.id })
        .catch(() => null);
      if (closedState) {
        states.push(closedState);
      }
    }
  }
  return states;
}

export async function closeLiveEditPreviewTabs(
  api: NativeApi,
  target: LiveEditPreviewCloseTarget = {},
): Promise<ThreadBrowserState[]> {
  const records = Array.from(previewTabRecordsByKey.entries()).filter(([, record]) =>
    matchesCloseTarget(record, target),
  );
  const states: ThreadBrowserState[] = [];
  const closedTabKeys = new Set<string>();
  for (const [recordKey, record] of records) {
    previewTabRecordsByKey.delete(recordKey);
    const state = await api.browser.getState({ threadId: record.threadId }).catch(() => null);
    if (!state?.tabs.some((tab) => tab.id === record.tabId)) {
      continue;
    }
    closedTabKeys.add(`${record.threadId}:${record.tabId}`);
    const closedState = await api.browser
      .closeTab({ threadId: record.threadId, tabId: record.tabId })
      .catch(() => null);
    if (closedState) {
      states.push(closedState);
    }
  }
  const fallbackThreadIds = uniqueThreadIds([
    ...(target.fallbackThreadIds ?? []),
    ...(target.threadId ? [target.threadId] : []),
    ...records.map(([, record]) => record.threadId),
  ]);
  const globalBrowserStates = target.closeLocalPreviewTabs
    ? await api.browser.listStates().catch(() => null)
    : null;
  states.push(
    ...(await closeMatchingUrlTabs(
      api,
      fallbackThreadIds,
      target.urls ?? [],
      closedTabKeys,
      globalBrowserStates ?? undefined,
    )),
  );
  if (target.closeLocalPreviewTabs) {
    states.push(
      ...(await closeLocalPreviewTabs(
        api,
        fallbackThreadIds,
        closedTabKeys,
        globalBrowserStates ?? undefined,
      )),
    );
  }
  return states;
}
