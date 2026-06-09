// FILE: ReviewDockPane.tsx
// Purpose: Right-dock wrapper that mounts the shared review surface in dock mode.
// Layer: Chat right-dock UI
// Depends on: reviewStore (selected source per scope), useReviewCwd, ReviewEntryPanel, ReviewPrView, ReviewSurface.

import type { ReviewSourceRef, ThreadId } from "@t3tools/contracts";
import { Suspense, lazy } from "react";

import { selectReviewSource, useReviewStore } from "~/reviewStore";
import { cn } from "~/lib/utils";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
} from "../chat/chatHeaderControls";
import { PanelStateMessage } from "../chat/PanelStateMessage";
import { Button } from "../ui/button";
import { ReviewEntryPanel } from "./ReviewEntryPanel";
import { useReviewCwd } from "./useReviewCwd";

const ReviewSurface = lazy(() =>
  import("./ReviewSurface").then((module) => ({ default: module.ReviewSurface })),
);

const ReviewPrView = lazy(() =>
  import("./ReviewPrView").then((module) => ({ default: module.ReviewPrView })),
);

export function ReviewDockPane(props: { threadId: ThreadId }) {
  const scope = `dock:${props.threadId}`;
  const source = useReviewStore(selectReviewSource(scope));
  const setSource = useReviewStore((store) => store.setSource);
  const clearSource = useReviewStore((store) => store.clearSource);

  // The dock follows the first/only resolvable project; explicit project
  // switching stays on the full-page route, which persists it in the URL.
  const { resolvedCwd, selectedProjectName } = useReviewCwd(undefined);

  const handleSelectSource = (next: ReviewSourceRef) => {
    setSource(scope, next);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {source?._tag === "pullRequest" ? null : (
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 px-2",
            CHAT_SURFACE_HEADER_HEIGHT_CLASS,
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
          )}
        >
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground"
            title={selectedProjectName}
          >
            {selectedProjectName}
          </span>
          {source ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => clearSource(scope)}
            >
              Choose another
            </Button>
          ) : null}
        </div>
      )}

      {source?._tag === "pullRequest" ? (
        <Suspense
          fallback={<PanelStateMessage density="compact">Loading pull request</PanelStateMessage>}
        >
          <ReviewPrView
            cwd={resolvedCwd}
            reference={source.reference}
            source={source}
            hostThreadId={props.threadId}
          />
        </Suspense>
      ) : source ? (
        <Suspense
          fallback={<PanelStateMessage density="compact">Loading review</PanelStateMessage>}
        >
          <ReviewSurface mode="dock" cwd={resolvedCwd} source={source} />
        </Suspense>
      ) : (
        <ReviewEntryPanel mode="dock" cwd={resolvedCwd} onSelectSource={handleSelectSource} />
      )}
    </div>
  );
}
