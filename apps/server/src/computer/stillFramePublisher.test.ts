import { describe, expect, it, vi } from "vitest";

import { StillFramePublisher } from "./stillFramePublisher.ts";
import type { ComputerStreamFrame } from "./ComputerBackend.ts";

const FRAME_A = new Uint8Array([1, 2, 3]);
const FRAME_B = new Uint8Array([4, 5, 6, 7]);

interface Harness {
  readonly publisher: StillFramePublisher;
  readonly frames: ComputerStreamFrame[];
  readonly observed: ComputerStreamFrame[];
  captures: number;
}

function makePublisher(
  capture: () => Promise<Uint8Array | undefined>,
  options: { readonly captureAvailable?: () => boolean; readonly intervalMs?: number } = {},
): Harness {
  const frames: ComputerStreamFrame[] = [];
  const observed: ComputerStreamFrame[] = [];
  const harness: Harness = {
    frames,
    observed,
    captures: 0,
    publisher: new StillFramePublisher({
      capture: async () => {
        harness.captures += 1;
        return await capture();
      },
      isCaptureAvailable: options.captureAvailable ?? (() => true),
      emit: (frame) => observed.push(frame),
      now: () => 0,
      intervalMs: options.intervalMs ?? 100,
    }),
  };
  return harness;
}

describe("StillFramePublisher", () => {
  it("publishes the first frame, dedupes identical ones, and republishes on a keyframe", async () => {
    let bytes = FRAME_A;
    const harness = makePublisher(async () => bytes);
    await harness.publisher.attach((frame) => harness.frames.push(frame));

    expect(harness.frames).toHaveLength(1);
    // Both the attached pane and the event observers see the same still.
    expect(harness.observed).toEqual(harness.frames);

    await harness.publisher.publish();
    expect(harness.frames).toHaveLength(1);

    // A receiver with nothing to draw asks for one anyway.
    await harness.publisher.requestKeyframe();
    expect(harness.frames).toHaveLength(2);

    bytes = FRAME_B;
    await harness.publisher.publish();
    expect(harness.frames).toHaveLength(3);
    await harness.publisher.detach();
  });

  it("bounds the retries a failing forced capture buys", async () => {
    // The unbounded version re-armed the force on every failure, and the
    // `finally` block republished because a force was pending — a tight
    // recursion that never yielded to the timer for as long as captures failed.
    const harness = makePublisher(async () => {
      throw new Error("capture failed");
    });
    await harness.publisher.attach((frame) => harness.frames.push(frame));

    expect(harness.frames).toHaveLength(0);
    // The forced attach, plus exactly one immediate retry.
    expect(harness.captures).toBe(2);

    // The timer cadence takes over from here: one capture per tick, not a loop.
    await harness.publisher.publish();
    expect(harness.captures).toBe(3);
    await harness.publisher.detach();
  });

  it("gives a fresh keyframe request its own retry budget", async () => {
    const harness = makePublisher(async () => {
      throw new Error("capture failed");
    });
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    expect(harness.captures).toBe(2);

    // A later receiver's request must not inherit the exhausted budget of the
    // one before it: it has no picture either.
    await harness.publisher.requestKeyframe();
    expect(harness.captures).toBe(4);
    await harness.publisher.detach();
  });

  it("serves a keyframe requested while a capture was already in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = FRAME_A;
    let gated = false;
    const harness = makePublisher(async () => {
      if (gated) {
        gated = false;
        await gate;
      }
      return bytes;
    });

    await harness.publisher.attach((frame) => harness.frames.push(frame));
    expect(harness.frames).toHaveLength(1);

    gated = true;
    const inFlight = harness.publisher.publish();
    // Asked for precisely because the pane is blank; dropping it left the pane
    // blank until the desktop happened to change on its own.
    const keyframe = harness.publisher.requestKeyframe();
    release();
    await inFlight;
    await keyframe;

    // The in-flight capture deduped against what it had just published, and the
    // deferred force then published anyway despite the bytes being identical.
    expect(harness.frames).toHaveLength(2);
    await harness.publisher.detach();
  });

  it("skips a tick the backend declines without spending the force", async () => {
    // `undefined` is "step aside", not "failed": the backend noticed mid-capture
    // that another request owns the capture path.
    const harness = makePublisher(async () => undefined);
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    expect(harness.frames).toHaveLength(0);
    expect(harness.captures).toBe(1);
    await harness.publisher.detach();
  });

  it("never captures while the backend says capture is unavailable", async () => {
    const harness = makePublisher(async () => FRAME_A, { captureAvailable: () => false });
    await harness.publisher.attach((frame) => harness.frames.push(frame));
    await harness.publisher.publish();
    await harness.publisher.requestKeyframe();
    expect(harness.captures).toBe(0);
    expect(harness.frames).toHaveLength(0);
    await harness.publisher.detach();
  });

  it("stops the timer loop on detach", async () => {
    vi.useFakeTimers();
    try {
      let bytes = FRAME_A;
      const harness = makePublisher(async () => bytes, { intervalMs: 100 });
      await harness.publisher.attach((frame) => harness.frames.push(frame));
      await vi.advanceTimersByTimeAsync(250);
      const whileAttached = harness.captures;
      expect(whileAttached).toBeGreaterThan(1);

      await harness.publisher.detach();
      bytes = FRAME_B;
      await vi.advanceTimersByTimeAsync(500);
      // A detached publisher owns no timer, so nothing keeps pulling captures
      // out of a desktop nobody is watching.
      expect(harness.captures).toBe(whileAttached);
      expect(harness.frames).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps exactly the newest attach's timer when two attaches overlap", async () => {
    vi.useFakeTimers();
    try {
      const harness = makePublisher(async () => FRAME_A, { intervalMs: 100 });
      const firstFrames: ComputerStreamFrame[] = [];
      const secondFrames: ComputerStreamFrame[] = [];
      await Promise.all([
        harness.publisher.attach((frame) => firstFrames.push(frame)),
        harness.publisher.attach((frame) => secondFrames.push(frame)),
      ]);
      const settled = harness.captures;
      await vi.advanceTimersByTimeAsync(100);
      // One interval, not two: an orphaned timer nothing can clear would keep
      // capturing for the life of the process.
      expect(harness.captures).toBe(settled + 1);
      await harness.publisher.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});
