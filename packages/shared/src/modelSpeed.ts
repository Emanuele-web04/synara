// FILE: modelSpeed.ts
// Purpose: The model-speed metric (output tokens per second of generation) shared
// by the server, which measures and persists it per turn, and the web, which
// shows it on settled turns, the context meter, and the profile.
// Layer: shared runtime utility (no I/O).

import type { TurnModelSpeed } from "@synara/contracts";

import { isProviderKind } from "./providerInstances";

// Below these a rate is mostly latency or rounding noise.
export const MODEL_SPEED_MIN_OUTPUT_TOKENS = 20;
export const MODEL_SPEED_MIN_GENERATION_MS = 1_000;
// No served model streams this fast. A higher rate means the token count holds
// work done outside the measured window (for example a subagent's output while
// its tool call was excluded), so one bad turn cannot skew an average.
export const MODEL_SPEED_MAX_TOKENS_PER_SECOND = 1_500;

export const MODEL_SPEED_DESCRIPTION =
  "Model speed: output tokens ÷ generation time (excludes tools and approvals)";

/** Rate for a measured turn, or null when the numbers would be misleading. */
export function modelSpeedTokensPerSecond(
  outputTokens: number,
  generationMs: number,
): number | null {
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(generationMs) ||
    outputTokens < MODEL_SPEED_MIN_OUTPUT_TOKENS ||
    generationMs < MODEL_SPEED_MIN_GENERATION_MS
  ) {
    return null;
  }
  const tokensPerSecond = outputTokens / (generationMs / 1_000);
  return tokensPerSecond <= MODEL_SPEED_MAX_TOKENS_PER_SECOND ? tokensPerSecond : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads a measured speed from an activity payload: `modelSpeed` on a settled
 * turn's `turn.completed`, `liveModelSpeed` on a running turn's
 * `context-window.updated`.
 */
export function readTurnModelSpeed(
  payload: unknown,
  field: "modelSpeed" | "liveModelSpeed" = "modelSpeed",
): TurnModelSpeed | null {
  if (!payload || typeof payload !== "object") return null;
  const speed = (payload as Record<string, unknown>)[field];
  if (!speed || typeof speed !== "object") return null;
  const record = speed as Record<string, unknown>;
  const outputTokens = nonNegativeInteger(record.outputTokens);
  const generationMs = nonNegativeInteger(record.generationMs);
  if (outputTokens === null || generationMs === null) return null;
  if (modelSpeedTokensPerSecond(outputTokens, generationMs) === null) return null;
  const model = nonEmptyString(record.model);
  const effort = nonEmptyString(record.effort);
  return {
    outputTokens,
    generationMs,
    ...(isProviderKind(record.provider) ? { provider: record.provider } : {}),
    ...(model ? { model } : {}),
    ...(typeof record.fastMode === "boolean" ? { fastMode: record.fastMode } : {}),
    ...(effort ? { effort } : {}),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Fast variants published as their own slug (`claude-opus-4-8-fast`, `gpt-5.5-fast`). */
export function isFastModelSlug(model: string | null | undefined): boolean {
  return typeof model === "string" && /-fast$/iu.test(model.trim());
}

/**
 * Fast mode of a turn: the selection's `fastMode` option (the composer only
 * sends it for models that support it) or a dedicated `-fast` slug.
 */
export function resolveTurnFastMode(input: {
  readonly model?: string | null | undefined;
  readonly selectedFastMode?: boolean | null | undefined;
}): boolean {
  return input.selectedFastMode === true || isFastModelSlug(input.model);
}

export function turnModelSpeedsEqual(
  left: TurnModelSpeed | null | undefined,
  right: TurnModelSpeed | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.outputTokens === right.outputTokens &&
    left.generationMs === right.generationMs &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.fastMode === right.fastMode &&
    left.effort === right.effort
  );
}

export interface ModelSpeedGroup {
  readonly provider?: TurnModelSpeed["provider"];
  readonly model?: string;
  readonly fastMode: boolean;
  // Present only when every turn of the group used the same effort.
  readonly effort?: string;
  readonly outputTokens: number;
  readonly generationMs: number;
  readonly tokensPerSecond: number | null;
}

/** Groups measured turns by model and fast mode, in first-seen order. */
export function groupModelSpeedsByModel(speeds: ReadonlyArray<TurnModelSpeed>): ModelSpeedGroup[] {
  const groups = new Map<
    string,
    {
      provider?: TurnModelSpeed["provider"];
      model?: string;
      fastMode: boolean;
      efforts: Set<string | undefined>;
      outputTokens: number;
      generationMs: number;
    }
  >();
  for (const speed of speeds) {
    const fastMode = speed.fastMode === true;
    const key = `${speed.provider ?? ""}\u0000${speed.model ?? ""}\u0000${fastMode}`;
    const group = groups.get(key);
    if (group) {
      group.outputTokens += speed.outputTokens;
      group.generationMs += speed.generationMs;
      group.efforts.add(speed.effort);
    } else {
      groups.set(key, {
        ...(speed.provider ? { provider: speed.provider } : {}),
        ...(speed.model ? { model: speed.model } : {}),
        fastMode,
        efforts: new Set([speed.effort]),
        outputTokens: speed.outputTokens,
        generationMs: speed.generationMs,
      });
    }
  }
  return Array.from(groups.values(), (group): ModelSpeedGroup => {
    const [effort] = group.efforts;
    return {
      ...(group.provider ? { provider: group.provider } : {}),
      ...(group.model ? { model: group.model } : {}),
      fastMode: group.fastMode,
      ...(group.efforts.size === 1 && effort ? { effort } : {}),
      outputTokens: group.outputTokens,
      generationMs: group.generationMs,
      tokensPerSecond: modelSpeedTokensPerSecond(group.outputTokens, group.generationMs),
    };
  });
}

/** Token-weighted rate of several measured turns (sum of tokens ÷ sum of time). */
export function combinedModelSpeedTokensPerSecond(
  speeds: ReadonlyArray<Pick<TurnModelSpeed, "outputTokens" | "generationMs">>,
): number | null {
  let outputTokens = 0;
  let generationMs = 0;
  for (const speed of speeds) {
    outputTokens += speed.outputTokens;
    generationMs += speed.generationMs;
  }
  return speeds.length > 0 ? modelSpeedTokensPerSecond(outputTokens, generationMs) : null;
}

export function formatModelSpeed(tokensPerSecond: number): string {
  return `${Math.round(tokensPerSecond).toLocaleString("en-US")} tok/s`;
}

export interface TimeIntervalMs {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Total time covered by the union of `intervals`, clipped to the window.
 * Overlapping intervals (a tool running while an approval is pending, parallel
 * tool calls) count once.
 */
export function unionDurationMs(
  intervals: ReadonlyArray<TimeIntervalMs>,
  windowStartMs: number,
  windowEndMs: number,
): number {
  const clipped = intervals
    .map((interval) => ({
      startMs: Math.max(windowStartMs, interval.startMs),
      endMs: Math.min(windowEndMs, interval.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .toSorted((left, right) => left.startMs - right.startMs);
  let total = 0;
  let currentStart: number | null = null;
  let currentEnd = 0;
  for (const interval of clipped) {
    if (currentStart === null || interval.startMs > currentEnd) {
      if (currentStart !== null) total += currentEnd - currentStart;
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
    } else {
      currentEnd = Math.max(currentEnd, interval.endMs);
    }
  }
  if (currentStart !== null) total += currentEnd - currentStart;
  return total;
}
