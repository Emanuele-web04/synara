import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";

import {
  bufferLiveUiStream,
  makeLiveUiStreamLagState,
  normalizeLiveUiStreamBufferCapacity,
  recordLiveUiStreamIngress,
} from "./wsStreamBackpressure";

describe("wsStreamBackpressure", () => {
  it("normalizes invalid buffer capacities to safe positive values", () => {
    expect(normalizeLiveUiStreamBufferCapacity(2.9)).toBe(2);
    expect(normalizeLiveUiStreamBufferCapacity(0)).toBe(1);
    expect(normalizeLiveUiStreamBufferCapacity(Number.NaN)).toBeGreaterThan(1);
  });

  it("keeps the newest live UI events when the buffer overflows", async () => {
    const values = await Effect.runPromise(
      Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
        (stream) => bufferLiveUiStream(stream, { capacity: 2 }),
        Stream.runCollect,
      ),
    );

    expect(Array.from(values)).toEqual([4, 5]);
  });

  it("can fail on overflow so snapshot-backed streams restart", async () => {
    await expect(
      Effect.runPromise(
        Stream.fromIterable([1, 2, 3]).pipe(
          (stream) =>
            bufferLiveUiStream(stream, {
              capacity: 1,
              onDroppedEvents: () => Effect.fail(new Error("resync")),
            }),
          Stream.runCollect,
        ),
      ),
    ).rejects.toThrow("resync");
  });

  it("reports nothing while the subscriber keeps up", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
    state.egressCount += 1;
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 2)).toBeNull();
  });

  it("reports the first overflow and then only growth past the step", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBe(1);
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 3)).toBe(4);
  });

  it("stops reporting once egress catches the lag back up", () => {
    const state = makeLiveUiStreamLagState();
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBeNull();
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBe(1);
    state.egressCount += 2;
    expect(recordLiveUiStreamIngress(state, 1, 1)).toBeNull();
  });
});
