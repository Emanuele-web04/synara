import { describe, expect, it } from "vitest";

import { stripGoalCompletionSentinel } from "./orchestrationGoals";

describe("orchestration goal display helpers", () => {
  it("strips an exact final completion sentinel line", () => {
    expect(stripGoalCompletionSentinel("Done.\n<goal-complete/>")).toEqual({
      text: "Done.",
      hadSentinel: true,
    });
  });

  it("does not strip quoted or non-terminal sentinels", () => {
    expect(stripGoalCompletionSentinel("Do not print <goal-complete/>.")).toEqual({
      text: "Do not print <goal-complete/>.",
      hadSentinel: false,
    });
    expect(stripGoalCompletionSentinel("<goal-complete/>\nDone.")).toEqual({
      text: "<goal-complete/>\nDone.",
      hadSentinel: false,
    });
  });
});
