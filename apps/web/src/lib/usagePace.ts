// FILE: usagePace.ts
// Purpose: Derive OpenUsage-style quota pace indicators from percent-used windows.
// Used by Settings usage meters to show reserve/deficit and projected run-out timing.

export type UsagePaceStatus = "ahead" | "on-track" | "behind";

export interface UsagePaceSummary {
  status: UsagePaceStatus;
  expectedRemainingPercent: number;
  amountText: string | null;
  etaText: string | null;
}

const MIN_ELAPSED_FRACTION = 0.05;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function compactDuration(deltaMs: number): string | null {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return null;
  }
  const totalMinutes = Math.floor(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "<1m";
}

function paceStatus(usedPercent: number, projectedUsedPercent: number): UsagePaceStatus {
  if (usedPercent >= 100) {
    return "behind";
  }
  if (usedPercent === 0 || projectedUsedPercent <= 80) {
    return "ahead";
  }
  if (projectedUsedPercent <= 100) {
    return "on-track";
  }
  return "behind";
}

function reserveOrDeficitText(deltaPercent: number): string | null {
  const rounded = Math.round(Math.abs(deltaPercent));
  if (rounded <= 0) {
    return null;
  }
  return deltaPercent > 0 ? `${rounded}% in deficit` : `${rounded}% in reserve`;
}

export function deriveUsagePace(input: {
  nowMs?: number | undefined;
  remainingPercent: number;
  resetsAt?: string | undefined;
  windowDurationMins?: number | undefined;
}): UsagePaceSummary | null {
  if (!input.resetsAt || input.windowDurationMins === undefined) {
    return null;
  }
  const resetMs = Date.parse(input.resetsAt);
  const durationMs = input.windowDurationMins * 60_000;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(resetMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  const periodStartMs = resetMs - durationMs;
  const elapsedMs = nowMs - periodStartMs;
  if (elapsedMs <= 0 || nowMs >= resetMs) {
    return null;
  }

  const usedPercent = clampPercent(100 - input.remainingPercent);
  const elapsedFraction = elapsedMs / durationMs;
  if (elapsedFraction < MIN_ELAPSED_FRACTION && usedPercent > 0 && usedPercent < 100) {
    return null;
  }

  const expectedUsedPercent = clampPercent(elapsedFraction * 100);
  const expectedRemainingPercent = clampPercent(100 - expectedUsedPercent);
  const projectedUsedPercent = usedPercent === 0 ? 0 : usedPercent / elapsedFraction;
  const status = paceStatus(usedPercent, projectedUsedPercent);
  const deltaPercent = usedPercent - expectedUsedPercent;
  const amountText = reserveOrDeficitText(deltaPercent);

  let etaText = status === "behind" ? null : "Lasts until reset";
  if (status === "behind") {
    const ratePercentPerMs = projectedUsedPercent / durationMs;
    const etaMs = ratePercentPerMs > 0 ? (100 - usedPercent) / ratePercentPerMs : 0;
    const remainingMs = resetMs - nowMs;
    const durationText = etaMs > 0 && etaMs < remainingMs ? compactDuration(etaMs) : null;
    etaText =
      usedPercent >= 100 ? "Limit reached" : durationText ? `Runs out in ${durationText}` : null;
  }

  return {
    status,
    expectedRemainingPercent,
    amountText,
    etaText,
  };
}
