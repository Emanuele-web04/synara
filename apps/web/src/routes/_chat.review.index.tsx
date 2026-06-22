// FILE: _chat.review.index.tsx
// Purpose: Triage board landing over a project's pull requests under the shared chat shell.
// Layer: Route screen

import type { ReviewSourceRef } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useState } from "react";

import {
  CHAT_CONTENT_CARD_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import { PanelStateMessage } from "../components/chat/PanelStateMessage";
import { ReviewBoard } from "../components/review/ReviewBoard";
import { ReviewRouteChrome } from "../components/review/ReviewRouteChrome";
import { useReviewCwd } from "../components/review/useReviewCwd";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { cn } from "../lib/utils";

const ReviewEntryPanel = lazy(() =>
  import("../components/review/ReviewEntryPanel").then((module) => ({
    default: module.ReviewEntryPanel,
  })),
);

const ReviewSurface = lazy(() =>
  import("../components/review/ReviewSurface").then((module) => ({
    default: module.ReviewSurface,
  })),
);

export interface ReviewIndexSearch {
  cwd?: string | undefined;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function ReviewIndexRouteView() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { resolvedCwd, projects, selectedProjectName } = useReviewCwd(search.cwd);
  const [showEntry, setShowEntry] = useState(false);
  const [branchSource, setBranchSource] = useState<ReviewSourceRef | null>(null);
  const hasSelectedProject =
    resolvedCwd !== null && projects.some((project) => project.cwd === resolvedCwd);

  const handleSelectSource = (source: ReviewSourceRef) => {
    if (source._tag === "pullRequest") {
      void navigate({
        to: "/review/$reference",
        params: { reference: source.reference },
        ...(resolvedCwd ? { search: { cwd: resolvedCwd } } : {}),
      });
      return;
    }
    setBranchSource(source);
  };

  return (
    <SidebarInset
      className={CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
      surfaceClassName={cn("review-shell-card bg-background", CHAT_CONTENT_CARD_CLASS_NAME)}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <ReviewRouteChrome
          cwd={resolvedCwd}
          reference={null}
          currentTitle={null}
          selectedProjectName={selectedProjectName}
          projects={projects.map((project) => ({
            id: project.id,
            cwd: project.cwd,
            label: project.localName ?? project.name,
          }))}
          onProjectChange={(value) => {
            void navigate({
              to: "/review",
              replace: true,
              search: (previous) => ({ ...previous, cwd: value }),
            });
          }}
        >
          {branchSource ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 rounded-xl px-2.5 text-[11px]"
              onClick={() => setBranchSource(null)}
            >
              Review board
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 rounded-xl px-2.5 text-[11px]"
              disabled={!hasSelectedProject}
              onClick={() => setShowEntry((previous) => !previous)}
            >
              {showEntry ? "Review board" : "Open by reference"}
            </Button>
          )}
        </ReviewRouteChrome>

        {branchSource ? (
          <Suspense
            fallback={
              <PanelStateMessage density="compact" fill="flex">
                Loading review
              </PanelStateMessage>
            }
          >
            <ReviewSurface mode="page" cwd={resolvedCwd} source={branchSource} />
          </Suspense>
        ) : showEntry ? (
          <Suspense
            fallback={
              <PanelStateMessage density="compact" fill="flex">
                Loading review picker
              </PanelStateMessage>
            }
          >
            <ReviewEntryPanel cwd={resolvedCwd} onSelectSource={handleSelectSource} />
          </Suspense>
        ) : (
          <ReviewBoard cwd={resolvedCwd} />
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/review/")({
  validateSearch: (search): ReviewIndexSearch => ({
    cwd: normalizeSearchString(search.cwd),
  }),
  component: ReviewIndexRouteView,
});
