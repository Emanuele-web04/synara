// Duration hints change placement, never test eligibility. Unseen files still run.
export function balancedShards(files, count, durations = {}) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid shard count');
  if (new Set(files).size !== files.length) throw new Error('Duplicate test file');
  const weight = (file) => {
    const duration = durations[file];
    return 0.5 + (Number.isFinite(duration) && duration > 0 ? duration : 0);
  };
  const ordered = files.toSorted((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const bins = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const file of ordered) {
    const bin = bins.reduce((best, next) => next.seconds < best.seconds ? next : best);
    bin.files.push(file);
    bin.seconds += weight(file);
  }
  return bins.map((bin) => bin.files);
}
