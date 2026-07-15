// FILE: PullRequestDiffStat.tsx
// Purpose: The "+N -M" additions/deletions counter shown wherever the pull request feature
//          summarizes a change size — list rows, the detail branch line, and the diff-tab totals.
//          Uses the semantic success/destructive status tones (intentionally distinct from the
//          diff viewer's own decoration colors) with tabular-nums so counts stay column-aligned.
// Layer: Pull request presentation
// Exports: PullRequestDiffStat

import { cn } from "~/lib/utils";

export function PullRequestDiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1 tabular-nums", className)}>
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">-{deletions}</span>
    </span>
  );
}
