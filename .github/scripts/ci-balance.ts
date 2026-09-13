// Timing hints affect placement only, never test discovery or eligibility.
export function balance<T>(
  items: readonly T[],
  count: number,
  key: (item: T) => string,
  weights: Readonly<Record<string, number>>,
  fallbackMs: number,
): T[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid shard count");
  const fallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : 1_000;
  const weight = (item: T): number => {
    const value = weights[key(item)];
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const ordered = [...items].sort((left, right) => {
    const delta = weight(right) - weight(left);
    if (delta) return delta;
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
  });
  const buckets: T[][] = Array.from({ length: count }, () => []);
  const totals = Array.from({ length: count }, () => 0);
  for (const item of ordered) {
    let target = 0;
    for (let index = 1; index < count; index++) {
      if (totals[index]! < totals[target]!) target = index;
    }
    buckets[target]!.push(item);
    totals[target]! += weight(item);
  }
  return buckets;
}
