// Summaries in the shape of the reference benchmark file, plus every raw sample.
export function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

const round = (value) =>
  Math.abs(value) >= 100 ? Math.round(value * 10) / 10 : Math.round(value * 1000) / 1000;

/** `samples` may contain nulls for failed runs; they are counted, never replaced. */
export function summarize(samples, unit) {
  const valid = samples.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) {
    return {
      result: "not measured",
      cause: "no valid sample",
      runs: 0,
      failed: samples.length,
      unit,
      samples: [],
    };
  }
  return {
    median: round(median(valid)),
    min: round(Math.min(...valid)),
    max: round(Math.max(...valid)),
    runs: valid.length,
    failed: samples.length - valid.length,
    unit,
    samples: valid.map(round),
  };
}

export const gap = (result, cause) => ({ result, cause });
