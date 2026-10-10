import { describe, expect, it } from "vitest";

import {
  bufferPreSnapshotThreadEvent,
  createPreSnapshotThreadEventBuffer,
  drainPreSnapshotThreadEvents,
  shouldApplyThreadStreamSnapshot,
} from "./-threadDetailSnapshotOrdering";

describe("shouldApplyThreadStreamSnapshot", () => {
  it("applies the first snapshot and any snapshot at or past the cursor", () => {
    expect(
      shouldApplyThreadStreamSnapshot({
        snapshotSequence: 4,
        appliedSequence: undefined,
        resumeSeedSequence: undefined,
      }),
    ).toBe(true);
    expect(
      shouldApplyThreadStreamSnapshot({
        snapshotSequence: 9,
        appliedSequence: 9,
        resumeSeedSequence: undefined,
      }),
    ).toBe(true);
  });

  it("rejects a snapshot older than events the stream already applied", () => {
    expect(
      shouldApplyThreadStreamSnapshot({
        snapshotSequence: 5,
        appliedSequence: 9,
        resumeSeedSequence: undefined,
      }),
    ).toBe(false);
    // The cursor moved past the resume seed, so the older snapshot is a race.
    expect(
      shouldApplyThreadStreamSnapshot({
        snapshotSequence: 5,
        appliedSequence: 12,
        resumeSeedSequence: 9,
      }),
    ).toBe(false);
  });

  it("accepts an older snapshot while the cursor is still the cached resume seed", () => {
    // A server-side reset restarts sequences below the cached resume cursor.
    expect(
      shouldApplyThreadStreamSnapshot({
        snapshotSequence: 3,
        appliedSequence: 40,
        resumeSeedSequence: 40,
      }),
    ).toBe(true);
  });
});

const event = (sequence: number) => ({ sequence });

describe("pre-snapshot thread event buffer", () => {
  it("drains events after the applied sequence in order", () => {
    const buffer = createPreSnapshotThreadEventBuffer<{ sequence: number }>();
    for (const sequence of [7, 5, 6, 3]) {
      bufferPreSnapshotThreadEvent(buffer, event(sequence), 8);
    }
    expect(drainPreSnapshotThreadEvents(buffer, 4)).toEqual({
      events: [event(5), event(6), event(7)],
      lostEvents: false,
    });
    expect(drainPreSnapshotThreadEvents(undefined, 4)).toEqual({ events: [], lostEvents: false });
  });

  it("keeps draining when overflow dropped only events the snapshot covers", () => {
    const buffer = createPreSnapshotThreadEventBuffer<{ sequence: number }>();
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      bufferPreSnapshotThreadEvent(buffer, event(sequence), 4);
    }
    expect(buffer.droppedThroughSequence).toBe(2);
    expect(drainPreSnapshotThreadEvents(buffer, 2)).toEqual({
      events: [event(3), event(4), event(5), event(6)],
      lostEvents: false,
    });
  });

  it("reports lost events when overflow dropped events past the snapshot", () => {
    const buffer = createPreSnapshotThreadEventBuffer<{ sequence: number }>();
    for (let sequence = 2; sequence <= 9; sequence += 1) {
      bufferPreSnapshotThreadEvent(buffer, event(sequence), 4);
    }
    // Events 2..5 were dropped; a snapshot at 3 does not cover 4 and 5, so
    // applying 6..9 would leave a hole in the thread.
    expect(drainPreSnapshotThreadEvents(buffer, 3)).toEqual({ events: [], lostEvents: true });
  });
});
