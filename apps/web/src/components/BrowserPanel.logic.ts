// FILE: BrowserPanel.logic.ts
// Purpose: Holds address-bar rules plus renderer lifecycle guards for the in-app browser panel.
// Layer: Component logic helper
// Exports: address helpers, panel hide scheduling, and one-shot renderer-loss recovery
// Depends on: shared browser URL rules, browser tab metadata, and thread-local browser history

import {
  BROWSER_BLANK_URL,
  BROWSER_SEARCH_URL_PREFIX,
  normalizeBrowserUrlInput,
} from "@synara/shared/browserSession";
import type { BrowserTabState } from "@synara/contracts";
import type { BrowserHistoryEntry } from "../browserStateStore";

const BROWSER_SUGGESTION_LIMIT = 6;

export interface BrowserRendererRecovery {
  readonly tabId: string;
  readonly generation: number;
}

interface BrowserRendererLossHandlerInput<TRenderer> {
  readonly renderer: TRenderer;
  readonly rendererGeneration: number;
  readonly tabId: string;
  readonly isCurrent: (renderer: TRenderer) => boolean;
  readonly detach: (renderer: TRenderer) => void;
  readonly recover: (recovery: BrowserRendererRecovery) => void;
}

/**
 * Coalesces Electron's overlapping guest-loss signals into one renderer
 * replacement. The current-renderer guard also makes a queued event from an
 * older guest harmless after its successor has attached.
 */
export function createBrowserRendererLossHandler<TRenderer>({
  renderer,
  rendererGeneration,
  tabId,
  isCurrent,
  detach,
  recover,
}: BrowserRendererLossHandlerInput<TRenderer>): () => void {
  let handled = false;
  return () => {
    if (handled || !isCurrent(renderer)) {
      return;
    }
    handled = true;
    try {
      detach(renderer);
    } finally {
      recover({ tabId, generation: rendererGeneration + 1 });
    }
  };
}

export interface BrowserPanelHideScheduler {
  readonly cancel: (threadId: string) => void;
  readonly schedule: (threadId: string, hide: () => void) => void;
}

type BrowserPanelHideTimer = ReturnType<typeof globalThis.setTimeout>;

/**
 * Defers renderer teardown by one task so React StrictMode's development-only
 * setup/cleanup/setup cycle can cancel the passive hide before it reaches the
 * desktop human-control boundary. A real unmount has no matching setup and
 * therefore still calls hide on the next task.
 */
export function createBrowserPanelHideScheduler(
  setTimer: (callback: () => void) => BrowserPanelHideTimer = (callback) =>
    globalThis.setTimeout(callback, 0),
  clearTimer: (timer: BrowserPanelHideTimer) => void = (timer) => globalThis.clearTimeout(timer),
): BrowserPanelHideScheduler {
  const pendingByThreadId = new Map<string, BrowserPanelHideTimer>();

  function cancel(threadId: string): void {
    const pending = pendingByThreadId.get(threadId);
    if (pending === undefined) return;
    pendingByThreadId.delete(threadId);
    clearTimer(pending);
  }

  function schedule(threadId: string, hide: () => void): void {
    cancel(threadId);
    const pending = setTimer(() => {
      if (pendingByThreadId.get(threadId) !== pending) return;
      pendingByThreadId.delete(threadId);
      hide();
    });
    pendingByThreadId.set(threadId, pending);
  }

  return { cancel, schedule };
}

interface ResolveBrowserAddressSyncInput {
  activeTabId: string | null;
  previousActiveTabId: string | null;
  savedDraft: string | undefined;
  nextDisplayValue: string;
  lastSyncedValue: string | undefined;
  isEditing: boolean;
}

type BrowserAddressSyncDecision =
  | {
      type: "keep";
    }
  | {
      type: "replace";
      value: string;
      syncedValue: string | undefined;
    };

export interface BrowserAddressSuggestion {
  id: string;
  kind: "navigate" | "tab" | "history";
  title: string;
  detail: string;
  url: string;
  tabId?: string;
  faviconUrl?: string | null;
}

interface BuildBrowserAddressSuggestionsInput {
  query: string;
  activeTabId: string | null;
  tabs: Array<Pick<BrowserTabState, "id" | "title" | "url" | "faviconUrl" | "lastCommittedUrl">>;
  recentHistory: BrowserHistoryEntry[];
}

export interface BrowserChromeStatus {
  tone: "default" | "error";
  label: string;
}

// Hides about:blank from the address bar so new tabs behave like real browsers.
export function browserAddressDisplayValue(
  tab: Pick<BrowserTabState, "url"> | null | undefined,
): string {
  const nextUrl = tab?.url?.trim() ?? "";
  return nextUrl === BROWSER_BLANK_URL ? "" : nextUrl;
}

// Component-facing alias for the shared desktop/web browser URL normalizer.
export const normalizeBrowserAddressInput = normalizeBrowserUrlInput;

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function displaySuggestionUrl(value: string): string {
  return value.trim().replace(/^about:blank$/i, "");
}

function suggestionMatches(query: string, candidate: string): boolean {
  if (query.length === 0) {
    return true;
  }
  return normalizeQuery(candidate).includes(query);
}

function pushSuggestion(
  suggestions: BrowserAddressSuggestion[],
  seenUrls: Set<string>,
  suggestion: BrowserAddressSuggestion,
): void {
  if (suggestions.length >= BROWSER_SUGGESTION_LIMIT || seenUrls.has(suggestion.url)) {
    return;
  }

  seenUrls.add(suggestion.url);
  suggestions.push(suggestion);
}

// Builds browser-like suggestions from the typed query, open tabs, and recent history.
export function buildBrowserAddressSuggestions(
  input: BuildBrowserAddressSuggestionsInput,
): BrowserAddressSuggestion[] {
  const query = normalizeQuery(input.query);
  const suggestions: BrowserAddressSuggestion[] = [];
  const seenUrls = new Set<string>();
  const directTarget = normalizeBrowserAddressInput(input.query);

  if (query.length > 0) {
    const directTitle = directTarget.startsWith(BROWSER_SEARCH_URL_PREFIX)
      ? `Search the web for "${input.query.trim()}"`
      : `Open ${directTarget}`;
    pushSuggestion(suggestions, seenUrls, {
      id: `direct:${directTarget}`,
      kind: "navigate",
      title: directTitle,
      detail: directTarget,
      url: directTarget,
    });
  }

  for (const tab of input.tabs) {
    const tabUrl = displaySuggestionUrl(tab.lastCommittedUrl ?? tab.url);
    if (tabUrl.length === 0 || tab.id === input.activeTabId) {
      continue;
    }
    if (!suggestionMatches(query, `${tab.title} ${tabUrl}`)) {
      continue;
    }
    pushSuggestion(suggestions, seenUrls, {
      id: `tab:${tab.id}`,
      kind: "tab",
      title: tab.title || tabUrl,
      detail: tabUrl,
      url: tabUrl,
      tabId: tab.id,
      faviconUrl: tab.faviconUrl,
    });
  }

  for (const entry of input.recentHistory) {
    const entryUrl = displaySuggestionUrl(entry.url);
    if (entryUrl.length === 0) {
      continue;
    }
    if (!suggestionMatches(query, `${entry.title} ${entryUrl}`)) {
      continue;
    }
    pushSuggestion(suggestions, seenUrls, {
      id: `history:${entry.url}`,
      kind: "history",
      title: entry.title || entryUrl,
      detail: entryUrl,
      url: entryUrl,
    });
  }

  return suggestions.slice(0, BROWSER_SUGGESTION_LIMIT);
}

// Only shows transient browser state; the address field already reflects the active URL.
export function resolveBrowserChromeStatus(input: {
  localError: string | null;
  threadLastError: string | null | undefined;
  activeTabStatus: string;
  hasActiveTab: boolean;
  workspaceReady: boolean;
}): BrowserChromeStatus | null {
  if (input.localError) {
    return {
      tone: "error",
      label: input.localError,
    };
  }

  if (input.threadLastError) {
    return {
      tone: "error",
      label: input.threadLastError,
    };
  }

  if (!input.hasActiveTab) {
    return {
      tone: "default",
      label: input.workspaceReady ? "No tabs open" : "Starting browser...",
    };
  }

  if (input.activeTabStatus === "suspended") {
    return {
      tone: "default",
      label: "Restoring tab...",
    };
  }

  return null;
}

// Decides when browser state should replace the visible address input.
export function resolveBrowserAddressSync(
  input: ResolveBrowserAddressSyncInput,
): BrowserAddressSyncDecision {
  if (!input.activeTabId) {
    return {
      type: "replace",
      value: "",
      syncedValue: undefined,
    };
  }

  if (input.activeTabId !== input.previousActiveTabId) {
    if (input.savedDraft !== undefined) {
      return {
        type: "replace",
        value: input.savedDraft,
        syncedValue: input.lastSyncedValue,
      };
    }

    return {
      type: "replace",
      value: input.nextDisplayValue,
      syncedValue: input.nextDisplayValue,
    };
  }

  if (input.isEditing || input.lastSyncedValue === input.nextDisplayValue) {
    return { type: "keep" };
  }

  return {
    type: "replace",
    value: input.nextDisplayValue,
    syncedValue: input.nextDisplayValue,
  };
}
