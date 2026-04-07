// FILE: splitViewRoute.ts
// Purpose: Bridges route search params and split view state so route consumers can stay focused on UI logic.
// Layer: Route helpers
// Exports: split route helpers shared by chat surface, sidebar, and thread-scoped UI

import { type ThreadId } from "@t3tools/contracts";
import { type DiffRouteSearch } from "./diffRouteSearch";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneForThread,
  type SplitView,
} from "./splitViewStore";

export function resolveActiveSplitView(input: {
  splitView: SplitView | null;
  routeThreadId: ThreadId | null;
}): {
  splitView: SplitView | null;
  focusedThreadId: ThreadId | null;
  routePane: "left" | "right" | null;
} {
  const { routeThreadId, splitView } = input;
  if (!splitView) {
    return {
      splitView: null,
      focusedThreadId: routeThreadId,
      routePane: null,
    };
  }

  return {
    splitView,
    focusedThreadId: resolveSplitViewFocusedThreadId(splitView),
    routePane: resolveSplitViewPaneForThread(splitView, routeThreadId),
  };
}

export function isSplitRoute(search: DiffRouteSearch): boolean {
  return typeof search.splitViewId === "string" && search.splitViewId.length > 0;
}
