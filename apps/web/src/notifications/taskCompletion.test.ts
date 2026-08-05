import { describe, expect, it } from "vitest";

import { shouldAttemptSystemTaskNotification } from "./taskCompletion.logic";

describe("shouldAttemptSystemTaskNotification", () => {
  it("does not interrupt a focused Synara window for its own completion", () => {
    expect(
      shouldAttemptSystemTaskNotification({
        enabled: true,
        isWindowForeground: true,
      }),
    ).toBe(false);
  });

  it("notifies when the result arrives while Synara is not in the foreground", () => {
    expect(
      shouldAttemptSystemTaskNotification({
        enabled: true,
        isWindowForeground: false,
      }),
    ).toBe(true);
  });
});
