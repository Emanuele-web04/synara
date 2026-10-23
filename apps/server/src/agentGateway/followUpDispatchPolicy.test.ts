import { describe, expect, it } from "vitest";

import {
  FOLLOW_UP_DISPATCH_DESCRIPTION,
  FOLLOW_UP_MODE_DESCRIPTION,
} from "./followUpDispatchPolicy.ts";

describe("follow-up dispatch policy", () => {
  it("conserves queue for ordinary follow-ups and never calls it simple queueing", () => {
    expect(FOLLOW_UP_DISPATCH_DESCRIPTION).toContain('mode "queue" (default)');
    expect(FOLLOW_UP_DISPATCH_DESCRIPTION).toContain("never interrupts");
    // The declared behavior of a steer, including the non-native fallback the
    // runtime performs: head-of-queue plus an interrupt.
    expect(FOLLOW_UP_DISPATCH_DESCRIPTION).toContain(
      "steers the live turn where the provider supports that natively",
    );
    expect(FOLLOW_UP_DISPATCH_DESCRIPTION).toContain(
      "queues the message at the head and interrupts the running turn",
    );
    expect(FOLLOW_UP_DISPATCH_DESCRIPTION).toContain("must take effect immediately");
    expect(FOLLOW_UP_DISPATCH_DESCRIPTION).toContain("With no live turn both modes start normally");
  });

  it("states the same interrupt policy on the mode argument", () => {
    expect(FOLLOW_UP_MODE_DESCRIPTION).toContain('"queue" (default) never interrupts');
    expect(FOLLOW_UP_MODE_DESCRIPTION).toContain('"steer" interrupts');
    expect(FOLLOW_UP_MODE_DESCRIPTION).toContain(
      "queues the message first and stops the running turn",
    );
  });
});
