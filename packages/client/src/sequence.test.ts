import { describe, expect, it } from "vitest";

import { CompanionSequenceTracker } from "./sequence";

describe("CompanionSequenceTracker", () => {
  it("requires every subscription to begin with a snapshot", () => {
    const tracker = new CompanionSequenceTracker();
    expect(tracker.observe(1)).toEqual({
      disposition: "gap",
      previous: null,
      received: 1,
    });
    expect(tracker.current).toBeNull();
  });

  it("resets from snapshots, suppresses duplicates, and reports gaps", () => {
    const tracker = new CompanionSequenceTracker();

    expect(tracker.observe(10, true).disposition).toBe("snapshot");
    expect(tracker.observe(11).disposition).toBe("next");
    expect(tracker.observe(11).disposition).toBe("duplicate");
    expect(tracker.observe(13)).toEqual({
      disposition: "gap",
      previous: 11,
      received: 13,
    });
    expect(tracker.current).toBe(11);
    expect(tracker.observe(20, true).disposition).toBe("snapshot");
    expect(tracker.current).toBe(20);
  });
});
