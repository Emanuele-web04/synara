import { describe, expect, it } from "vitest";

import {
  COORDINATOR_SUGGESTION_CHIPS,
  shouldShowCoordinatorSuggestions,
  visibleCoordinatorSuggestionChips,
} from "./coordinatorSuggestions.logic";

describe("shouldShowCoordinatorSuggestions", () => {
  it("shows chips only on a coordinator thread with one assistant message and no user messages", () => {
    expect(
      shouldShowCoordinatorSuggestions({
        isCoordinatorThread: true,
        messages: [{ role: "assistant" }],
      }),
    ).toBe(true);
    expect(
      shouldShowCoordinatorSuggestions({
        isCoordinatorThread: false,
        messages: [{ role: "assistant" }],
      }),
    ).toBe(false);
    expect(
      shouldShowCoordinatorSuggestions({
        isCoordinatorThread: true,
        messages: [{ role: "assistant" }, { role: "user" }],
      }),
    ).toBe(false);
    expect(
      shouldShowCoordinatorSuggestions({
        isCoordinatorThread: true,
        messages: [{ role: "assistant" }, { role: "assistant" }],
      }),
    ).toBe(false);
    expect(COORDINATOR_SUGGESTION_CHIPS).toHaveLength(3);
  });
});

describe("visibleCoordinatorSuggestionChips", () => {
  it("shows every chip while the group's setup is unknown", () => {
    expect(
      visibleCoordinatorSuggestionChips({
        hasGoal: undefined,
        instructionsConfigured: undefined,
        linkedProjectCount: 0,
      }),
    ).toEqual(["Connect repositories", "Add a goal", "Write instructions"]);
  });

  it("hides the chip for each setting that is already filled", () => {
    expect(
      visibleCoordinatorSuggestionChips({
        hasGoal: true,
        instructionsConfigured: true,
        linkedProjectCount: 2,
      }),
    ).toEqual([]);
    expect(
      visibleCoordinatorSuggestionChips({
        hasGoal: true,
        instructionsConfigured: false,
        linkedProjectCount: 0,
      }),
    ).toEqual(["Connect repositories", "Write instructions"]);
    expect(
      visibleCoordinatorSuggestionChips({
        hasGoal: false,
        instructionsConfigured: false,
        linkedProjectCount: 1,
      }),
    ).toEqual(["Add a goal", "Write instructions"]);
  });
});
