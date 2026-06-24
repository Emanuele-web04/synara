import type { ReviewCommit } from "@t3tools/contracts";

import { GitCommitIcon } from "~/lib/icons";
import { EmptyState, formatRelativeReviewTime } from "./reviewPrimitives";

export function ReviewCommits(props: { commits: ReadonlyArray<ReviewCommit> }) {
  if (props.commits.length === 0) {
    return (
      <EmptyState icon={<GitCommitIcon />} title="No commits">
        This pull request has no commits.
      </EmptyState>
    );
  }

  return (
    <ul className="my-4 flex w-full flex-col divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card/88 shadow-sm">
      {props.commits.map((commit) => {
        const when = formatRelativeReviewTime(commit.authoredDate);
        return (
          <li key={commit.oid} className="flex min-w-0 items-start gap-2 px-4 py-2.5">
            <GitCommitIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className="min-w-0 truncate font-medium text-[13px] text-foreground"
                title={commit.messageHeadline}
              >
                {commit.messageHeadline}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {commit.author.length > 0 ? (
                  <span className="truncate">{commit.author}</span>
                ) : null}
                {when ? <span className="tabular-nums">{when}</span> : null}
              </span>
            </div>
            <code className="shrink-0 rounded-lg bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
              {commit.abbreviatedOid}
            </code>
          </li>
        );
      })}
    </ul>
  );
}
