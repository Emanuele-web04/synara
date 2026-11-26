// FILE: reachability.test.ts
// Purpose: The attempt-based status line — including
//          that "unreachable" and "no answer" stay distinguishable (ADR 0010).
// Layer: Web remote-access feature tests.

import { describe, expect, it } from "vitest";

import { reachabilityLabel, reachabilityToneClassName } from "./reachability";

describe("reachabilityLabel", () => {
  it("reads as prose for every state", () => {
    expect(reachabilityLabel({ state: "unknown" })).toBe("Not checked yet");
    expect(reachabilityLabel({ state: "probing" })).toBe("Checking…");
    expect(reachabilityLabel({ state: "reachable", transport: "relay", at: 1 })).toBe(
      "Reachable over relay",
    );
    expect(reachabilityLabel({ state: "reachable", transport: "loopback", at: 1 })).toBe(
      "Reachable over this machine",
    );
    expect(reachabilityLabel({ state: "unreachable", at: 1 })).toBe("Did not answer");
    expect(reachabilityLabel({ state: "no-answer", at: 1 })).toBe(
      "No response — check your network",
    );
    expect(reachabilityLabel({ state: "no-route", at: 1 })).toBe("No known address");
  });
});

describe("reachabilityToneClassName", () => {
  // ADR 0010 + the palette: reachability is text and emphasis, never a
  // colored dot. There is no success/warning token to reach for.
  it("uses emphasis rather than color", () => {
    expect(reachabilityToneClassName({ state: "reachable", transport: "lan", at: 1 })).toBe(
      "text-foreground",
    );
    expect(reachabilityToneClassName({ state: "unreachable", at: 1 })).toBe(
      "text-muted-foreground",
    );
    expect(reachabilityToneClassName({ state: "unknown" })).toBe("text-muted-foreground");
  });

  it("never reaches for a status color", () => {
    for (const tone of [
      reachabilityToneClassName({ state: "reachable", transport: "lan", at: 1 }),
      reachabilityToneClassName({ state: "unreachable", at: 1 }),
      reachabilityToneClassName({ state: "no-answer", at: 1 }),
    ]) {
      expect(tone).not.toMatch(/success|warning|green|red|destructive/);
    }
  });
});
