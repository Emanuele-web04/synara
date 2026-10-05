import { describe, expect, it } from "vitest";

import { formatModelSpeedChange, formatModelSpeedWeekTooltip } from "./ProfileModelSpeedRow";

describe("ProfileModelSpeedRow formatting", () => {
  it("formats the week-over-week change and hides it without data", () => {
    expect(formatModelSpeedChange(8)).toBe("↑ 8%");
    expect(formatModelSpeedChange(-20)).toBe("↓ 20%");
    expect(formatModelSpeedChange(0)).toBe("→ 0%");
    expect(formatModelSpeedChange(null)).toBeNull();
  });

  it("describes measured and empty weeks", () => {
    const week = {
      weekStart: "2026-09-28",
      outputTokens: 1_200,
      generationMs: 30_000,
      turnCount: 2,
      tokensPerSecond: 40,
    };
    expect(formatModelSpeedWeekTooltip(week)).toMatch(/^Week of .+: 40 tok\/s · 2 turns$/u);
    expect(
      formatModelSpeedWeekTooltip({
        ...week,
        outputTokens: 0,
        generationMs: 0,
        turnCount: 0,
        tokensPerSecond: null,
      }),
    ).toMatch(/: no measured turns$/u);
  });
});
