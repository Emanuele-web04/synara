import { memo } from "react";

import { cn } from "~/lib/utils";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  showParentheses?: boolean;
}) {
  const { additions, deletions, showParentheses = false } = props;
  return (
    <>
      {showParentheses && <span className="text-muted-foreground/70">(</span>}
      <span className="text-success">+{additions}</span>
      <span className="mx-1 text-destructive">-{deletions}</span>
      {showParentheses && <span className="text-muted-foreground/70">)</span>}
    </>
  );
});

// Zero-guarded monospace +/- badge. Renders nothing when there are no changes so
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
