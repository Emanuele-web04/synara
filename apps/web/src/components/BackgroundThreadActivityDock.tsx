// FILE: BackgroundThreadActivityDock.tsx
// Purpose: Shows persistent bottom status for chats that keep working outside the visible route.
// Layer: Global UI overlay
// Depends on: sidebar thread summaries, route visibility, and thread navigation

import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { collectBackgroundThreadActivityItems } from "../backgroundThreadActivity";
import {
  activityLabel,
  ActivityIcon,
  useVisibleThreadIdsFromRoute,
} from "../backgroundThreadActivityPresentation";
import { MessageCircleIcon, TriangleAlertIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import { createSidebarThreadSummariesSelector } from "../storeSelectors";

const MAX_VISIBLE_BACKGROUND_THREADS = 3;

export default function BackgroundThreadActivityDock() {
  const navigate = useNavigate();
  const threads = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const visibleThreadIds = useVisibleThreadIdsFromRoute();
  const activityItems = useMemo(
    () => collectBackgroundThreadActivityItems({ threads, visibleThreadIds, limit: 12 }),
    [threads, visibleThreadIds],
  );

  if (activityItems.length === 0) {
    return null;
  }

  if (typeof window !== "undefined" && window.desktopBridge?.petOverlay) {
    return null;
  }

  const visibleItems = activityItems.slice(0, MAX_VISIBLE_BACKGROUND_THREADS);
  const hiddenCount = Math.max(0, activityItems.length - visibleItems.length);
  const hasInputNeeded = activityItems.some((item) => item.kind === "input-needed");
  const title =
    activityItems.length === 1
      ? `${activityLabel(activityItems[0]!.kind)} in another chat`
      : `${activityItems.length} chats active`;

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => ({ ...previous, splitViewId: undefined }),
    });
  };

  return (
    <section
      aria-label="Background chat activity"
      className="pointer-events-none fixed right-4 bottom-4 left-4 z-50 flex justify-center"
      data-background-thread-activity-dock="true"
    >
      <div
        className={cn(
          "pointer-events-auto flex max-w-[min(720px,calc(100vw-2rem))] items-center gap-2 rounded-lg border bg-popover/96 px-2.5 py-2 text-popover-foreground shadow-lg/10 backdrop-blur-md",
          hasInputNeeded ? "border-amber-400/45" : "border-border/80",
        )}
      >
        <div className="flex min-w-0 items-center gap-2 px-1">
          {hasInputNeeded ? (
            <TriangleAlertIcon className="size-4 shrink-0 text-amber-500" />
          ) : (
            <MessageCircleIcon className="size-4 shrink-0 text-sky-500" />
          )}
          <span className="max-w-42 truncate text-xs font-medium">{title}</span>
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          {visibleItems.map((item) => (
            <button
              aria-label={`Open ${item.title}`}
              className="flex max-w-52 min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background/70 px-2 py-1 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={item.threadId}
              onClick={() => openThread(item.threadId)}
              title={`${activityLabel(item.kind)}: ${item.title}`}
              type="button"
            >
              <ActivityIcon kind={item.kind} />
              <span className="min-w-0 truncate">{item.title}</span>
            </button>
          ))}
          {hiddenCount > 0 && (
            <span className="shrink-0 px-1 text-xs text-muted-foreground">+{hiddenCount}</span>
          )}
        </div>
      </div>
    </section>
  );
}
