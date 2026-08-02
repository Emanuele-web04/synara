import { describe, expect, it } from "vitest";

import {
  ANCHOR_SLIDE_SNAP_DISTANCE_PX,
  advanceAnchorSlideOffset,
  scrollTranscriptToSettledEnd,
  stopTranscriptScrollAtCurrentOffset,
  type TranscriptScrollCancellationTarget,
  type TranscriptScrollTarget,
} from "./transcriptScroll";

describe("advanceAnchorSlideOffset", () => {
  it("approaches without ever overshooting the target", () => {
    let current = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      const next = advanceAnchorSlideOffset({ current, target: 500, deltaMs: 16 });
      expect(next).toBeGreaterThanOrEqual(current);
      expect(next).toBeLessThanOrEqual(500);
      current = next;
    }
    expect(current).toBe(500);
  });

  it("is framerate independent: sub-frames compose to the same offset", () => {
    const oneStep = advanceAnchorSlideOffset({ current: 0, target: 1_000, deltaMs: 32 });
    const half = advanceAnchorSlideOffset({ current: 0, target: 1_000, deltaMs: 16 });
    const twoSteps = advanceAnchorSlideOffset({ current: half, target: 1_000, deltaMs: 16 });
    expect(twoSteps).toBeCloseTo(oneStep, 6);
  });

  it("tracks a target that moves mid-flight instead of landing on a stale one", () => {
    // The end-space reserve growing during the slide moves the coordinate down.
    let current = advanceAnchorSlideOffset({ current: 0, target: 200, deltaMs: 16 });
    for (let frame = 0; frame < 60; frame += 1) {
      current = advanceAnchorSlideOffset({ current, target: 900, deltaMs: 16 });
    }
    expect(current).toBe(900);
  });

  it("snaps once the remaining distance is sub-pixel so the slide terminates", () => {
    expect(
      advanceAnchorSlideOffset({
        current: 100,
        target: 100 + ANCHOR_SLIDE_SNAP_DISTANCE_PX,
        deltaMs: 16,
      }),
    ).toBe(100 + ANCHOR_SLIDE_SNAP_DISTANCE_PX);
  });

  it("takes the target directly when no time has elapsed", () => {
    expect(advanceAnchorSlideOffset({ current: 0, target: 320, deltaMs: 0 })).toBe(320);
  });
});

describe("scrollTranscriptToSettledEnd", () => {
  it("interrupts a native smooth scroll at its current offset", async () => {
    const nativeScrollCalls: ScrollToOptions[] = [];
    const scrollToOffsetCalls: Array<{ offset: number; animated?: boolean | undefined }> = [];
    const scrollNode = {
      scrollTop: 420,
      scrollTo: (options: ScrollToOptions) => nativeScrollCalls.push(options),
    } as unknown as HTMLElement;
    const target: TranscriptScrollCancellationTarget = {
      getScrollableNode: () => scrollNode,
      scrollToOffset: async (options) => {
        scrollToOffsetCalls.push(options);
      },
    };

    await stopTranscriptScrollAtCurrentOffset(target);

    expect(nativeScrollCalls).toEqual([{ top: 420, behavior: "auto" }]);
    expect(scrollToOffsetCalls).toEqual([{ offset: 420, animated: false }]);
  });

  it("finishes a smooth jump with an exact non-animated tail settle", async () => {
    const animations: boolean[] = [];
    const target: TranscriptScrollTarget = {
      scrollToEnd: async ({ animated = true } = {}) => {
        animations.push(animated);
      },
    };

    await expect(scrollTranscriptToSettledEnd({ target, isCurrent: () => true })).resolves.toBe(
      true,
    );
    expect(animations).toEqual([true, false]);
  });

  it("does not snap a replacement transcript after the user takes over", async () => {
    let finishSmoothScroll: (() => void) | null = null;
    let current = true;
    const animations: boolean[] = [];
    const target: TranscriptScrollTarget = {
      scrollToEnd: ({ animated = true } = {}) => {
        animations.push(animated);
        return new Promise<void>((resolve) => {
          finishSmoothScroll = resolve;
        });
      },
    };

    const result = scrollTranscriptToSettledEnd({ target, isCurrent: () => current });
    current = false;
    expect(finishSmoothScroll).not.toBeNull();
    (finishSmoothScroll as unknown as () => void)();

    await expect(result).resolves.toBe(false);
    expect(animations).toEqual([true]);
  });
});
