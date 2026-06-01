import { memo } from "react";

import { cn } from "~/lib/utils";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
}) {
  const { additions, deletions } = props;
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className="text-[var(--color-decoration-added)]">+{additions}</span>
      <span className="text-[var(--color-decoration-deleted)]">-{deletions}</span>
    </span>
  );
});

// Zero-guarded monospace +/- stats. Renders nothing when there are no changes so
// callers can drop the repeated `hasNonZeroStat(...) ? <span font-mono>…` idiom.
// Sizing/layout stays caller-controlled via `className`.
export const DiffStat = memo(function DiffStat(props: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (!hasNonZeroStat(props)) {
    return null;
  }
  return (
    <span className={cn("font-mono", props.className)}>
      <DiffStatLabel additions={props.additions} deletions={props.deletions} />
    </span>
  );
});
