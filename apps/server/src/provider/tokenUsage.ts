// FILE: tokenUsage.ts
// Purpose: Shared numeric helpers for provider context-window and token-usage snapshots.
// Layer: Server provider utility
// Exports: finite/positive token guards and usage percent math.

export function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function clampUsagePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

export function computeUsagePercent(
  usedTokens: number,
  maxTokens: number | undefined,
): number | undefined {
  if (maxTokens === undefined) {
    return undefined;
  }
  return Math.min(100, Math.max(0, (usedTokens / maxTokens) * 100));
}
