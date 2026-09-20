import { describe, expect, it } from "vitest";

import {
  COORDINATOR_SUGGESTION_CHIPS,
  shouldShowCoordinatorSuggestions,
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
