import { describe, expect, it } from "vitest";

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  computeTailAnchorSpacerHeightPx,
  getScrollContainerDistanceFromBottom,
  isScrollContainerNearBottom,
} from "./chat-scroll";

describe("getScrollContainerDistanceFromBottom", () => {
  it("returns the remaining distance when the viewport is above the bottom", () => {
    expect(
      getScrollContainerDistanceFromBottom({
        scrollTop: 520,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(80);
  });

  it("clamps negative distances and non-finite values", () => {
    expect(
      getScrollContainerDistanceFromBottom({
        scrollTop: 620,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(0);
    expect(
      getScrollContainerDistanceFromBottom({
        scrollTop: Number.NaN,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(0);
  });
});

describe("isScrollContainerNearBottom", () => {
  it("returns true when already at bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 600,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns true when within the auto-scroll threshold", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 540,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns false when the user is meaningfully above the bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 520,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(false);
  });

  it("clamps negative thresholds to zero", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 539,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        -1,
      ),
    ).toBe(false);
  });

  it("falls back to the default threshold for non-finite values", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 540,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        Number.NaN,
      ),
    ).toBe(true);
    expect(AUTO_SCROLL_BOTTOM_THRESHOLD_PX).toBe(64);
  });
});

describe("computeTailAnchorSpacerHeightPx", () => {
  it("reserves the viewport space left after the anchored message and its response", () => {
    // 600px viewport, 120px of content from the anchor top to the spacer,
    // 16px container bottom padding -> 464px reserve keeps the anchor at the top.
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 600,
        anchorTopToSpacerTopPx: 120,
        trailingInsetPx: 16,
        topInsetPx: 0,
        baseInsetPx: 64,
      }),
    ).toBe(464);
  });

  it("keeps the top inset gap so the anchor breathes like a chat's first message", () => {
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 600,
        anchorTopToSpacerTopPx: 120,
        trailingInsetPx: 16,
        topInsetPx: 16,
        baseInsetPx: 64,
      }),
    ).toBe(448);
  });

  it("shrinks one-for-one as the streamed response grows", () => {
    const at = (contentBelowAnchorPx: number) =>
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 600,
        anchorTopToSpacerTopPx: contentBelowAnchorPx,
        trailingInsetPx: 0,
        topInsetPx: 16,
        baseInsetPx: 64,
      });
    expect(at(100) - at(180)).toBe(80);
  });

  it("clamps to the base inset once the response overflows the viewport", () => {
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 600,
        anchorTopToSpacerTopPx: 900,
        trailingInsetPx: 16,
        topInsetPx: 16,
        baseInsetPx: 64,
      }),
    ).toBe(64);
  });

  it("never reserves more than one viewport of space", () => {
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 600,
        anchorTopToSpacerTopPx: -50,
        trailingInsetPx: 0,
        topInsetPx: 0,
        baseInsetPx: 64,
      }),
    ).toBe(600);
  });

  it("falls back to the base inset for non-finite or degenerate measurements", () => {
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: Number.NaN,
        anchorTopToSpacerTopPx: 120,
        trailingInsetPx: 16,
        topInsetPx: 16,
        baseInsetPx: 64,
      }),
    ).toBe(64);
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 0,
        anchorTopToSpacerTopPx: 120,
        trailingInsetPx: 16,
        topInsetPx: 16,
        baseInsetPx: 64,
      }),
    ).toBe(64);
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 600,
        anchorTopToSpacerTopPx: Number.NaN,
        trailingInsetPx: 16,
        topInsetPx: 16,
        baseInsetPx: 64,
      }),
    ).toBe(64);
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 600,
        anchorTopToSpacerTopPx: 120,
        trailingInsetPx: 16,
        topInsetPx: Number.NaN,
        baseInsetPx: 64,
      }),
    ).toBe(64);
  });

  it("keeps the base inset floor even in tiny viewports", () => {
    expect(
      computeTailAnchorSpacerHeightPx({
        viewportHeightPx: 40,
        anchorTopToSpacerTopPx: 10,
        trailingInsetPx: 0,
        topInsetPx: 16,
        baseInsetPx: 64,
      }),
    ).toBe(64);
  });
});
