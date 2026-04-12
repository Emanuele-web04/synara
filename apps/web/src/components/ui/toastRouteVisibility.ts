// FILE: toastRouteVisibility.ts
// Purpose: Keeps thread-scoped toasts visible for every thread currently rendered in the route.
// Layer: UI helpers
// Exports: visible-thread resolver shared by toast containers and split-aware tests

import type { ThreadId } from "@t3tools/contracts";
import { resolveSplitViewThreadIds, type SplitView } from "../../splitViewStore";

export function resolveVisibleToastThreadIds(input: {
  activeThreadId: ThreadId | null;
  splitView: SplitView | null;
}): ReadonlySet<ThreadId> {
  if (input.splitView) {
    return new Set(resolveSplitViewThreadIds(input.splitView));
  }
  return input.activeThreadId ? new Set([input.activeThreadId]) : new Set<ThreadId>();
}

export function shouldRenderToastForVisibleThreads(input: {
  allowCrossThreadVisibility?: boolean | undefined;
  toastThreadId?: ThreadId | null | undefined;
  visibleThreadIds: ReadonlySet<ThreadId>;
}): boolean {
  if (input.allowCrossThreadVisibility) {
    return true;
  }
  const toastThreadId = input.toastThreadId;
  if (!toastThreadId) {
    return true;
  }
  return input.visibleThreadIds.has(toastThreadId);
}
