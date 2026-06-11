import { describe, expect, it } from "vitest";

import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_MAX_TIER,
  COMPOSER_FOOTER_TIER_PROMOTION_SLACK_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  composerFooterPlanForTier,
  resolveNextComposerFooterTier,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";

describe("shouldUseCompactComposerFooter", () => {
  it("stays expanded without a measured width", () => {
    expect(shouldUseCompactComposerFooter(null)).toBe(false);
  });

  it("switches to compact mode below the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("stays expanded at and above the breakpoint", () => {
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX)).toBe(false);
    expect(shouldUseCompactComposerFooter(COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX + 48)).toBe(false);
  });

  it("uses a higher breakpoint for wide action states", () => {
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerFooter(COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});

describe("composerFooterPlanForTier", () => {
  it("maps tiers to the degradation order: meter, traits label, model label, relocation", () => {
    expect(composerFooterPlanForTier(0, true)).toEqual({
      showContextMeter: true,
      showTraitsLabel: true,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(1, true)).toEqual({
      showContextMeter: false,
      showTraitsLabel: true,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(2, true)).toEqual({
      showContextMeter: false,
      showTraitsLabel: false,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(3, true)).toEqual({
      showContextMeter: false,
      showTraitsLabel: false,
      showModelLabel: false,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(COMPOSER_FOOTER_MAX_TIER, true)).toEqual({
      showContextMeter: false,
      showTraitsLabel: false,
      showModelLabel: false,
      relocateLeadingControls: true,
    });
  });

  it("never shows the context meter when the thread has none", () => {
    expect(composerFooterPlanForTier(0, false).showContextMeter).toBe(false);
  });
});

describe("resolveNextComposerFooterTier", () => {
  it("keeps the tier when the footer fits", () => {
    expect(
      resolveNextComposerFooterTier({
        currentTier: 0,
        clientWidth: 500,
        isOverflowing: false,
        demotionWidths: [],
      }),
    ).toEqual({ tier: 0, demotionWidths: [] });
  });

  it("demotes one step and records the overflow width", () => {
    const step = resolveNextComposerFooterTier({
      currentTier: 0,
      clientWidth: 400,
      isOverflowing: true,
      demotionWidths: [],
    });
    expect(step.tier).toBe(1);
    expect(step.demotionWidths[0]).toBe(400);
  });

  it("keeps demoting on repeated overflow until the max tier", () => {
    let demotionWidths: ReadonlyArray<number | undefined> = [];
    let tier = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      const step = resolveNextComposerFooterTier({
        currentTier: tier,
        clientWidth: 300,
        isOverflowing: true,
        demotionWidths,
      });
      tier = step.tier;
      demotionWidths = step.demotionWidths;
    }
    expect(tier).toBe(COMPOSER_FOOTER_MAX_TIER);
  });

  it("promotes back only after clearing the recorded width plus slack", () => {
    const demotionWidths = [400];
    const tooNarrow = resolveNextComposerFooterTier({
      currentTier: 1,
      clientWidth: 400 + COMPOSER_FOOTER_TIER_PROMOTION_SLACK_PX - 1,
      isOverflowing: false,
      demotionWidths,
    });
    expect(tooNarrow.tier).toBe(1);
    const wideEnough = resolveNextComposerFooterTier({
      currentTier: 1,
      clientWidth: 400 + COMPOSER_FOOTER_TIER_PROMOTION_SLACK_PX,
      isOverflowing: false,
      demotionWidths,
    });
    expect(wideEnough.tier).toBe(0);
  });

  it("promotes multiple steps at once when width allows", () => {
    const step = resolveNextComposerFooterTier({
      currentTier: COMPOSER_FOOTER_MAX_TIER,
      clientWidth: 900,
      isOverflowing: false,
      demotionWidths: [400, 360, 320, 300],
    });
    expect(step.tier).toBe(0);
  });
});
