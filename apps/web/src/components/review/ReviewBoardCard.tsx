import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { ExternalLinkIcon } from "~/lib/icons";
import { ChecksStatusIcon } from "./reviewPrPrimitives";
import { ReviewCardShell, ReviewPullRequestMeta } from "./reviewPrimitives";

export function ReviewBoardCard(props: { pullRequest: ReviewPullRequestSummary; cwd: string }) {
  const navigate = useNavigate();
  const { pullRequest, cwd } = props;
  const reference = String(pullRequest.number);

  return (
    <div className="group/cardwrap relative">
      <ReviewCardShell
        onClick={() => {
          void navigate({ to: "/review/$reference", params: { reference }, search: { cwd } });
        }}
      >
        <div className="flex min-w-0 items-baseline gap-2">
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
        <ReviewPullRequestMeta pullRequest={pullRequest} />
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <ChecksStatusIcon status={pullRequest.checksStatus} />
          {pullRequest.checksStatus !== "none" ? (
            <span className="capitalize">{pullRequest.checksStatus} checks</span>
          ) : null}
        </div>
      </ReviewCardShell>
      {pullRequest.url.trim().length > 0 ? (
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          title="Open on GitHub"
          aria-label="Open on GitHub"
          className="absolute end-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-sm border border-border/70 bg-card text-muted-foreground opacity-55 transition-opacity duration-150 hover:bg-[var(--sidebar-accent)] hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none group-hover/cardwrap:opacity-100"
        >
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : null}
    </div>
  );
}
