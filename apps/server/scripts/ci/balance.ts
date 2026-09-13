// Scheduling only: every input appears in exactly one shard, including new tests.
export function balance<T>(
  files: readonly T[],
  count: number,
  key: (file: T) => string,
  estimate: (file: T) => number,
): T[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid shard count");
  const bins = Array.from({ length: count }, () => ({ files: [] as T[], seconds: 0 }));
  const weighted = files.map((file) => {
    const seconds = estimate(file);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid duration estimate");
    return { file, seconds, key: key(file) };
  });
  weighted.sort((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const item of weighted) {
    let target = bins[0]!;
    for (const bin of bins) {
      if (
        bin.seconds < target.seconds ||
        (bin.seconds === target.seconds && bin.files.length < target.files.length)
      ) {
        target = bin;
      }
    }
    target.files.push(item.file);
    target.seconds += item.seconds;
  }
  return bins.map((bin) => bin.files);
}
