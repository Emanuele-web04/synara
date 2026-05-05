// FILE: backgroundThreadActivityPresentation.tsx
// Purpose: Shares route visibility and presentation helpers for cross-chat activity surfaces.
// Layer: Global UI helpers
// Exports: split-aware visible thread hook plus activity labels/icons

import { ThreadId } from "@t3tools/contracts";
import { useParams, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

import type { BackgroundThreadActivityKind } from "./backgroundThreadActivity";
import { parseDiffRouteSearch } from "./diffRouteSearch";
import { LoaderCircleIcon, TriangleAlertIcon } from "./lib/icons";
import { selectSplitView, useSplitViewStore } from "./splitViewStore";
import { resolveVisibleToastThreadIds } from "./components/ui/toastRouteVisibility";

export function useVisibleThreadIdsFromRoute(): ReadonlySet<ThreadId> {
  const activeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const routeSearch = useSearch({
    strict: false,
    select: (search) => parseDiffRouteSearch(search),
  });
  const splitView = useSplitViewStore(selectSplitView(routeSearch.splitViewId ?? null));

  return useMemo(
    () => resolveVisibleToastThreadIds({ activeThreadId, splitView }),
    [activeThreadId, splitView],
  );
}

export function activityLabel(kind: BackgroundThreadActivityKind): string {
  switch (kind) {
    case "input-needed":
      return "Input needed";
    case "connecting":
      return "Connecting";
    case "working":
      return "Working";
  }
}

export function ActivityIcon({
  className = "size-3.5 shrink-0",
  kind,
}: {
  className?: string;
  kind: BackgroundThreadActivityKind;
}) {
  if (kind === "input-needed") {
    return <TriangleAlertIcon className={`${className} text-amber-500`} />;
  }
  return <LoaderCircleIcon className={`${className} animate-spin text-sky-500`} />;
}
