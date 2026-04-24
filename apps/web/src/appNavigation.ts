// FILE: appNavigation.ts
// Purpose: Owns the TanStack history instance and browser-style app navigation controls.
// Layer: Web app routing utility
// Exports: appHistory, route navigation helpers, and navigation availability state
// Depends on: TanStack Router history and the Electron environment flag

import {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { isElectron } from "./env";

type RouterHistory = ReturnType<typeof createBrowserHistory>;
type HistorySubscriberEvent = Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0];
type HistorySubscriberAction = HistorySubscriberEvent["action"];

const HISTORY_STATE_INDEX_KEY = "__TSR_index";

function createAppHistory(): RouterHistory {
  if (typeof window === "undefined") {
    return createMemoryHistory({ initialEntries: ["/"] });
  }
  // Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
  return isElectron ? createHashHistory() : createBrowserHistory();
}

export const appHistory: RouterHistory = createAppHistory();

const appHistoryMaxIndexByHistory = new WeakMap<RouterHistory, number>();

function readCurrentHistoryIndex(history: RouterHistory): number | null {
  const index = history.location.state[HISTORY_STATE_INDEX_KEY];
  return typeof index === "number" && Number.isFinite(index) ? index : null;
}

function resolveKnownAppHistoryMaxIndex(history: RouterHistory, currentIndex: number): number {
  const knownMaxIndex = appHistoryMaxIndexByHistory.get(history);
  if (typeof knownMaxIndex === "number") {
    return knownMaxIndex;
  }

  appHistoryMaxIndexByHistory.set(history, currentIndex);
  return currentIndex;
}

// Records the highest app-owned history index seen so browser-global history.length
// cannot make Forward look available before this app creates a forward entry.
export function syncAppNavigationState(
  history: RouterHistory = appHistory,
  action?: HistorySubscriberAction,
): AppNavigationState {
  const currentIndex = readCurrentHistoryIndex(history);
  if (currentIndex === null) {
    return {
      canGoBack: history.canGoBack(),
      canGoForward: false,
    };
  }

  const knownMaxIndex = resolveKnownAppHistoryMaxIndex(history, currentIndex);
  const nextMaxIndex =
    action?.type === "PUSH" ? currentIndex : Math.max(knownMaxIndex, currentIndex);
  if (nextMaxIndex !== knownMaxIndex) {
    appHistoryMaxIndexByHistory.set(history, nextMaxIndex);
  }

  return {
    canGoBack: history.canGoBack(),
    canGoForward: currentIndex < nextMaxIndex,
  };
}

export interface AppNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

// Flushes TanStack's queued URL writes before asking native history to move.
// This keeps rapid back/forward clicks aligned with the latest in-memory route.
export function goBackInAppHistory(history: RouterHistory = appHistory): void {
  history.flush();
  history.back();
}

export function goForwardInAppHistory(history: RouterHistory = appHistory): void {
  history.flush();
  history.forward();
}

// Derives forward availability from app-owned history indexes, not browser-global history length.
export function resolveAppNavigationState(history: RouterHistory = appHistory): AppNavigationState {
  const currentIndex = readCurrentHistoryIndex(history);
  if (currentIndex === null) {
    return {
      canGoBack: history.canGoBack(),
      canGoForward: false,
    };
  }

  const knownMaxIndex = resolveKnownAppHistoryMaxIndex(history, currentIndex);
  return {
    canGoBack: history.canGoBack(),
    canGoForward: currentIndex < knownMaxIndex,
  };
}

export function useAppNavigationState(): AppNavigationState {
  const [navigationState, setNavigationState] = useState(() => resolveAppNavigationState());

  useEffect(() => {
    const updateNavigationState = (event?: HistorySubscriberEvent) =>
      setNavigationState(syncAppNavigationState(appHistory, event?.action));
    const unsubscribe = appHistory.subscribe(updateNavigationState);
    updateNavigationState();
    return unsubscribe;
  }, []);

  return navigationState;
}
