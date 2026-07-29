import { describe, expect, it } from "vitest";

import { makeRuntimeJournalPoisonGate } from "./runtimeJournalPoisonGate.ts";

const START_MS = Date.parse("2026-07-29T12:00:00.000Z");

describe("makeRuntimeJournalPoisonGate", () => {
  it("declares poison only when both the attempt and wall-clock gates hold", () => {
    const gate = makeRuntimeJournalPoisonGate({ attemptLimit: 3, minBlockedMs: 1_000 });

    expect(gate.noteBlockedDrain(7, START_MS)).toBe(false);
    expect(gate.noteBlockedDrain(7, START_MS + 400)).toBe(false);
    // Attempt limit reached, but not enough wall-clock time with zero progress.
    expect(gate.noteBlockedDrain(7, START_MS + 800)).toBe(false);
    expect(gate.noteBlockedDrain(7, START_MS + 1_000)).toBe(true);
  });

  it("does not declare poison from a burst of attempts inside the time floor", () => {
    // A live-append burst during a transient stall: hundreds of blocked drains
    // in under a second must never dead-letter a healthy event.
    const gate = makeRuntimeJournalPoisonGate({ attemptLimit: 240, minBlockedMs: 60_000 });

    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      expect(gate.noteBlockedDrain(7, START_MS + attempt)).toBe(false);
    }
    // Once the same row has also been stuck for the full time floor, it trips.
    expect(gate.noteBlockedDrain(7, START_MS + 60_000)).toBe(true);
  });

  it("does not declare poison from slow retries that never reach the attempt limit", () => {
    const gate = makeRuntimeJournalPoisonGate({ attemptLimit: 5, minBlockedMs: 1_000 });

    expect(gate.noteBlockedDrain(7, START_MS)).toBe(false);
    expect(gate.noteBlockedDrain(7, START_MS + 30_000)).toBe(false);
    expect(gate.noteBlockedDrain(7, START_MS + 60_000)).toBe(false);
    expect(gate.noteBlockedDrain(7, START_MS + 90_000)).toBe(false);
  });

  it("resets both gates when the cursor makes progress", () => {
    const gate = makeRuntimeJournalPoisonGate({ attemptLimit: 2, minBlockedMs: 1_000 });

    expect(gate.noteBlockedDrain(7, START_MS)).toBe(false);
    // The cursor moved: whatever blocked before was not this row's fault.
    expect(gate.noteBlockedDrain(8, START_MS + 5_000)).toBe(false);
    expect(gate.noteBlockedDrain(8, START_MS + 5_500)).toBe(false);
    expect(gate.noteBlockedDrain(8, START_MS + 6_000)).toBe(true);
  });

  it("starts over after an explicit reset", () => {
    const gate = makeRuntimeJournalPoisonGate({ attemptLimit: 2, minBlockedMs: 0 });

    expect(gate.noteBlockedDrain(7, START_MS)).toBe(false);
    expect(gate.noteBlockedDrain(7, START_MS + 1)).toBe(true);
    gate.reset();
    expect(gate.noteBlockedDrain(7, START_MS + 2)).toBe(false);
    expect(gate.noteBlockedDrain(7, START_MS + 3)).toBe(true);
  });
});
