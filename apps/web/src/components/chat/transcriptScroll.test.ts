import { describe, expect, it } from "vitest";

import {
  scrollTranscriptToSettledEnd,
  stopTranscriptScrollAtCurrentOffset,
  type TranscriptScrollCancellationTarget,
  type TranscriptScrollTarget,
} from "./transcriptScroll";

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
