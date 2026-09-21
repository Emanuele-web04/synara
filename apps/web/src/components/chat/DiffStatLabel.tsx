export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export function DiffStatLabel(props: { additions: number; deletions: number }) {
  const { additions, deletions } = props;
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className="text-[var(--color-decoration-added)]">+{additions}</span>
      <span className="text-[var(--color-decoration-deleted)]">-{deletions}</span>
    </span>
  );
}

// zero-guarded +/− stats render nothing when unchanged; keeps tabular-nums for column alignment, sizing stays caller-controlled
export function DiffStat(props: { additions: number; deletions: number; className?: string }) {
  if (!hasNonZeroStat(props)) {
    return null;
  }
  return (
    <span className={props.className}>
      <DiffStatLabel additions={props.additions} deletions={props.deletions} />
    </span>
  );
}
