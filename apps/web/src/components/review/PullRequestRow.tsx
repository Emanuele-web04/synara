import type { ReviewPullRequestSummary, ReviewSourceRef } from "@t3tools/contracts";

import { GitPullRequestIcon } from "~/lib/icons";
import { ReviewCardShell, ReviewPullRequestMeta } from "./reviewPrimitives";

export function PullRequestRow(props: {
  pullRequest: ReviewPullRequestSummary;
  onSelectSource: (source: ReviewSourceRef) => void;
}) {
  const { pullRequest } = props;
  const reference = pullRequest.url.trim().length > 0 ? pullRequest.url : `#${pullRequest.number}`;

  return (
    <ReviewCardShell onClick={() => props.onSelectSource({ _tag: "pullRequest", reference })}>
      <div className="flex min-w-0 items-center gap-2">
        <GitPullRequestIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground leading-snug"
          title={pullRequest.title}
        >
          {pullRequest.title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          #{pullRequest.number}
        </span>
      </div>
      <ReviewPullRequestMeta pullRequest={pullRequest} showState />
    </ReviewCardShell>
  );
}
