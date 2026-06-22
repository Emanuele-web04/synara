// FILE: _chat.review.$reference.tsx
// Purpose: Deep-link to a resolved pull request changeset under the shared chat shell.
// Layer: Route screen

import type { ReviewSourceRef } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useMemo } from "react";

import {
  CHAT_CONTENT_CARD_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import { PanelStateMessage } from "../components/chat/PanelStateMessage";
import { ReviewRouteChrome } from "../components/review/ReviewRouteChrome";
import { useReviewCwd } from "../components/review/useReviewCwd";
import { SidebarInset } from "../components/ui/sidebar";
import { cn } from "../lib/utils";

const ReviewPrView = lazy(() =>
  import("../components/review/ReviewPrView").then((module) => ({
    default: module.ReviewPrView,
  })),
);

export interface ReviewReferenceSearch {
  cwd?: string | undefined;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function decodeReferenceParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ReviewReferenceRouteView() {
  const navigate = useNavigate();
  const params = Route.useParams();
  const search = Route.useSearch();
  const { resolvedCwd, projects, selectedProjectName } = useReviewCwd(search.cwd);

  const reference = useMemo(() => decodeReferenceParam(params.reference), [params.reference]);
  const source = useMemo<ReviewSourceRef>(() => ({ _tag: "pullRequest", reference }), [reference]);

  return (
    <SidebarInset
      className={CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
      surfaceClassName={cn("review-shell-card bg-background", CHAT_CONTENT_CARD_CLASS_NAME)}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <ReviewRouteChrome
          cwd={resolvedCwd}
          reference={reference}
          currentTitle={null}
          selectedProjectName={selectedProjectName}
          projects={projects.map((project) => ({
            id: project.id,
            cwd: project.cwd,
            label: project.localName ?? project.name,
          }))}
          onProjectChange={(value) => {
            void navigate({
              to: "/review/$reference",
              params: { reference: params.reference },
              replace: true,
              search: (previous) => ({ ...previous, cwd: value }),
            });
          }}
        />

        <Suspense
          fallback={
            <PanelStateMessage density="compact" fill="flex">
              Loading pull request
            </PanelStateMessage>
          }
        >
          <ReviewPrView cwd={resolvedCwd} reference={reference} source={source} />
        </Suspense>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/review/$reference")({
  validateSearch: (search): ReviewReferenceSearch => ({
    cwd: normalizeSearchString(search.cwd),
  }),
  component: ReviewReferenceRouteView,
});
