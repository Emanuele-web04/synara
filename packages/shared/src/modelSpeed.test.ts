import { describe, expect, it } from "vitest";

import {
  combinedModelSpeedTokensPerSecond,
  formatModelSpeed,
  groupModelSpeedsByModel,
  isFastModelSlug,
  resolveTurnFastMode,
  turnModelSpeedsEqual,
  modelSpeedTokensPerSecond,
  readTurnModelSpeed,
  unionDurationMs,
} from "./modelSpeed";

describe("unionDurationMs", () => {
  it("counts overlapping and nested intervals once", () => {
    expect(
      unionDurationMs(
        [
          { startMs: 10, endMs: 30 },
          { startMs: 20, endMs: 40 },
          { startMs: 22, endMs: 25 },
          { startMs: 60, endMs: 70 },
        ],
        0,
        100,
      ),
    ).toBe(40);
  });

  it("clips to the window and ignores empty intervals", () => {
    expect(
      unionDurationMs(
        [
          { startMs: -50, endMs: 10 },
          { startMs: 90, endMs: 200 },
          { startMs: 50, endMs: 50 },
          { startMs: 300, endMs: 400 },
        ],
        0,
        100,
      ),
    ).toBe(20);
  });
});

describe("modelSpeedTokensPerSecond", () => {
  it("divides output tokens by generation seconds", () => {
    expect(modelSpeedTokensPerSecond(850, 10_000)).toBe(85);
  });

  it("skips tiny turns, sub-second windows, and implausible rates", () => {
    expect(modelSpeedTokensPerSecond(19, 10_000)).toBeNull();
    expect(modelSpeedTokensPerSecond(500, 999)).toBeNull();
    // 2,061,157 tokens in 35s is subagent output leaking into the count.
    expect(modelSpeedTokensPerSecond(2_061_157, 35_000)).toBeNull();
    expect(modelSpeedTokensPerSecond(15_000, 10_000)).toBe(1_500);
  });
});

describe("readTurnModelSpeed", () => {
  it("reads settled and live payload fields", () => {
    expect(readTurnModelSpeed({ modelSpeed: { outputTokens: 400, generationMs: 4_000 } })).toEqual({
      outputTokens: 400,
      generationMs: 4_000,
    });
    expect(
      readTurnModelSpeed(
        { liveModelSpeed: { outputTokens: 400, generationMs: 4_000 } },
        "liveModelSpeed",
      ),
    ).toEqual({ outputTokens: 400, generationMs: 4_000 });
  });

  it("rejects missing, malformed, and out-of-threshold values", () => {
    expect(readTurnModelSpeed({ state: "completed" })).toBeNull();
    expect(readTurnModelSpeed({ modelSpeed: { outputTokens: "400", generationMs: 4_000 } })).toBe(
      null,
    );
    expect(readTurnModelSpeed({ modelSpeed: { outputTokens: 10, generationMs: 4_000 } })).toBe(
      null,
    );
  });
});

describe("combinedModelSpeedTokensPerSecond", () => {
  it("weights by tokens instead of averaging per-turn rates", () => {
    // 100 tok/s over 10s and 20 tok/s over 1s: mean of rates would be 60.
    expect(
      combinedModelSpeedTokensPerSecond([
        { outputTokens: 1_000, generationMs: 10_000 },
        { outputTokens: 20, generationMs: 1_000 },
      ]),
    ).toBeCloseTo(92.73, 2);
    expect(combinedModelSpeedTokensPerSecond([])).toBeNull();
  });
});

describe("formatModelSpeed", () => {
  it("rounds to whole tokens per second", () => {
    expect(formatModelSpeed(84.6)).toBe("85 tok/s");
    expect(formatModelSpeed(1_234.4)).toBe("1,234 tok/s");
  });
});

describe("model and fast mode", () => {
  it("reads model, fast mode, and effort from the payload", () => {
    expect(
      readTurnModelSpeed({
        modelSpeed: {
          outputTokens: 400,
          generationMs: 4_000,
          provider: "claudeAgent",
          model: "claude-opus-5-5",
          fastMode: true,
          effort: "high",
        },
      }),
    ).toEqual({
      outputTokens: 400,
      generationMs: 4_000,
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      fastMode: true,
      effort: "high",
    });
    expect(
      readTurnModelSpeed({
        modelSpeed: { outputTokens: 400, generationMs: 4_000, provider: "nope", fastMode: "yes" },
      }),
    ).toEqual({ outputTokens: 400, generationMs: 4_000 });
  });

  it("treats the fastMode option or a -fast slug as fast", () => {
    expect(isFastModelSlug("claude-opus-4-8-fast")).toBe(true);
    expect(isFastModelSlug("gpt-5.5-fast")).toBe(true);
    expect(isFastModelSlug("grok-code-fast-1")).toBe(false);
    expect(resolveTurnFastMode({ model: "gpt-5.5", selectedFastMode: true })).toBe(true);
    expect(resolveTurnFastMode({ model: "gpt-5.5", selectedFastMode: false })).toBe(false);
    expect(resolveTurnFastMode({ model: "gpt-5.5-fast" })).toBe(true);
  });

  it("groups turns by model and fast mode, keeping a shared effort only", () => {
    const groups = groupModelSpeedsByModel([
      { outputTokens: 1_000, generationMs: 10_000, model: "a", effort: "high" },
      { outputTokens: 500, generationMs: 10_000, model: "a", effort: "low" },
      { outputTokens: 900, generationMs: 10_000, model: "a", fastMode: true, effort: "high" },
    ]);
    expect(groups).toEqual([
      {
        model: "a",
        fastMode: false,
        outputTokens: 1_500,
        generationMs: 20_000,
        tokensPerSecond: 75,
      },
      {
        model: "a",
        fastMode: true,
        effort: "high",
        outputTokens: 900,
        generationMs: 10_000,
        tokensPerSecond: 90,
      },
    ]);
  });

  it("compares speeds by value", () => {
    const speed = { outputTokens: 1, generationMs: 2, model: "a", fastMode: true };
    expect(turnModelSpeedsEqual(speed, { ...speed })).toBe(true);
    expect(turnModelSpeedsEqual(speed, { ...speed, fastMode: false })).toBe(false);
    expect(turnModelSpeedsEqual(null, undefined)).toBe(true);
    expect(turnModelSpeedsEqual(speed, null)).toBe(false);
  });
});
