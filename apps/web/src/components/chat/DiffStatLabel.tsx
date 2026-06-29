import { memo } from "react";

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

// Zero-guarded +/- stats: renders nothing when there are no changes so callers
// can drop the repeated `hasNonZeroStat(...) ? <span>…` idiom. Inherits the UI
// font (DiffStatLabel keeps `tabular-nums` for column alignment) so the counts
// read like chrome, not code. Sizing/layout stays caller-controlled via `className`.
export const DiffStat = memo(function DiffStat(props: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (!hasNonZeroStat(props)) {
    return null;
  }
  return (
    <span className={props.className}>
      <DiffStatLabel additions={props.additions} deletions={props.deletions} />
    </span>
  );
});
