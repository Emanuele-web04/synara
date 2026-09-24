import { describe, expect, it } from "vitest";

import {
  ANCHOR_SLIDE_DURATION_MS,
  anchorSlideOffsetPx,
  scrollTranscriptToSettledEnd,
  type TranscriptScrollTarget,
} from "./transcriptScroll";

describe("anchorSlideOffsetPx", () => {
  const glide = (elapsedMs: number) => anchorSlideOffsetPx({ fromPx: 900, toPx: 20, elapsedMs });

  it("moves in one direction only, so the message never bounces on its way up", () => {
    let previous = glide(0);
    for (let elapsedMs = 8; elapsedMs <= ANCHOR_SLIDE_DURATION_MS; elapsedMs += 8) {
      const next = glide(elapsedMs);
      expect(next).toBeLessThanOrEqual(previous);
      expect(next).toBeGreaterThanOrEqual(20);
      previous = next;
    }
    expect(previous).toBe(20);
  });

  it("eases out: it covers more ground early than late", () => {
    const firstHalf = glide(0) - glide(ANCHOR_SLIDE_DURATION_MS / 2);
    const secondHalf = glide(ANCHOR_SLIDE_DURATION_MS / 2) - glide(ANCHOR_SLIDE_DURATION_MS);
    expect(firstHalf).toBeGreaterThan(secondHalf);
    expect(glide(ANCHOR_SLIDE_DURATION_MS / 2)).toBeCloseTo(900 - 880 * (1 - 0.5 ** 3), 6);
  });

  it("ignores a negative elapsed time and a zero duration rather than jumping", () => {
    expect(glide(-50)).toBe(900);
    expect(anchorSlideOffsetPx({ fromPx: 900, toPx: 20, elapsedMs: 0, durationMs: 0 })).toBe(20);
  });
});

describe("scrollTranscriptToSettledEnd", () => {
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
