import { describe, expect, it } from "vitest";

import {
  scrollTranscriptToSettledEnd,
  type TranscriptScrollTarget,
} from "./transcriptScroll";

describe("scrollTranscriptToSettledEnd", () => {
  it("finishes a smooth jump with an exact non-animated tail settle", async () => {
    const animations: boolean[] = [];
    const target: TranscriptScrollTarget = {
      scrollToEnd: async ({ animated = true } = {}) => {
        animations.push(animated);
      },
    };

    await expect(
      scrollTranscriptToSettledEnd({ target, isCurrent: () => true }),
    ).resolves.toBe(true);
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
