/* Hallmark · component: review board card · genre: modern-minimal · theme: in-system (dark tokens)
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (46–50)
 */
import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { ExternalLinkIcon } from "~/lib/icons";
import { ChecksStatusIcon } from "./reviewPrPrimitives";
import {
  ReviewCardShell,
  ReviewPullRequestMeta,
  splitConventionalCommitTitle,
} from "./reviewPrimitives";

export function ReviewBoardCard(props: { pullRequest: ReviewPullRequestSummary; cwd: string }) {
  const navigate = useNavigate();
  const { pullRequest, cwd } = props;
  const reference = String(pullRequest.number);
  const title = splitConventionalCommitTitle(pullRequest.title);

  return (
    <div className="group/cardwrap h-full min-h-0">
      <ReviewCardShell
        className="h-full min-h-0 overflow-hidden"
        onClick={() => {
          void navigate({ to: "/review/$reference", params: { reference }, search: { cwd } });
        }}
      >
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span
            className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground leading-snug"
            title={pullRequest.title}
          >
            {title.prefix ? (
              <span className="font-normal text-muted-foreground/70">{title.prefix} </span>
            ) : null}
            {title.rest}
          </span>
          {pullRequest.checksStatus !== "none" ? (
            <ChecksStatusIcon status={pullRequest.checksStatus} className="size-3.5 self-center" />
          ) : null}
          <span className="shrink-0 text-[11px] text-muted-foreground/80 tabular-nums">
            #{pullRequest.number}
          </span>
          {pullRequest.url.trim().length > 0 ? (
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              title="Open on GitHub"
              aria-label="Open on GitHub"
              className="inline-flex size-4 shrink-0 self-center items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/cardwrap:opacity-100"
            >
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
        <ReviewPullRequestMeta
          pullRequest={pullRequest}
          showDecision={false}
          className="min-h-0 flex-1 overflow-hidden"
        />
      </ReviewCardShell>
    </div>
  );
}
