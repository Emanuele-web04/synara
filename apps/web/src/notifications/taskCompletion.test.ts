import { afterEach, describe, expect, it, vi } from "vitest";

import { shouldAttemptSystemTaskNotification } from "./taskCompletion";

describe("shouldAttemptSystemTaskNotification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not interrupt a focused Synara window for its own completion", () => {
    vi.stubGlobal("document", {
      visibilityState: "visible",
      hasFocus: () => true,
    });

    expect(shouldAttemptSystemTaskNotification()).toBe(false);
  });

  it("notifies when the result arrives while Synara is not in the foreground", () => {
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      hasFocus: () => false,
    });

    expect(shouldAttemptSystemTaskNotification()).toBe(true);
  });
});
