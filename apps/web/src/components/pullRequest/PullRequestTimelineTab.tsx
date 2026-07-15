// FILE: PullRequestTimelineTab.tsx
// Purpose: The Timeline tab of the pull request detail surface — renders the chronological
//          event list (opened, commits, comments/reviews, merged/closed) produced by
//          buildPullRequestTimelineEvents as a simple left-rail timeline.
// Layer: Pull request presentation
// Exports: PullRequestTimelineTab

import type { PullRequestDetail } from "@synara/contracts";
import { useMemo } from "react";

import { formatRelativeTime } from "~/lib/relativeTime";
import { buildPullRequestTimelineEvents } from "./pullRequestDetail.logic";
import { PR_BODY_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";
import { cn } from "~/lib/utils";

export function PullRequestTimelineTab({ detail }: { detail: PullRequestDetail }) {
  const events = useMemo(() => buildPullRequestTimelineEvents(detail), [detail]);
  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="relative ml-2 border-l border-border/70 pl-5">
        {events.map((event) => (
          <article key={event.id} className={cn(PR_BODY_TEXT_CLASS_NAME, "relative pb-5")}>
            <span className="absolute -left-[1.55rem] top-1 size-2 rounded-full border border-border bg-background" />
            <div className="font-medium">{event.title}</div>
            <div className={cn(PR_META_TEXT_CLASS_NAME, "text-muted-foreground")}>
              {formatRelativeTime(event.at)}
            </div>
            {event.body ? (
              <p
                className={cn(
                  PR_META_TEXT_CLASS_NAME,
                  "mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground",
                )}
              >
                {event.body}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
