import { describe, expect, it } from "vitest";

import { CompanionRequestIdTracker } from "./idempotency";

describe("CompanionRequestIdTracker", () => {
  it("reuses an id until the matching logical mutation is acknowledged", () => {
    let next = 0;
    const tracker = new CompanionRequestIdTracker(() => `request-${++next}`);

    const first = tracker.acquire("send", "same payload");
    expect(tracker.acquire("send", "same payload")).toBe(first);
    tracker.acknowledge("send", "some-other-id");
    expect(tracker.acquire("send", "same payload")).toBe(first);
    tracker.acknowledge("send", first);
    expect(tracker.acquire("send", "same payload")).not.toBe(first);
  });

  it("rotates the id when the payload changes", () => {
    let next = 0;
    const tracker = new CompanionRequestIdTracker(() => `request-${++next}`);
    expect(tracker.acquire("send", "payload-a")).not.toBe(
      tracker.acquire("send", "payload-b"),
    );
  });
});
