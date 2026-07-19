import { describe, expect, it } from "vitest";

import {
  COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX,
  COMPOSER_FOOTER_MAX_TIER,
  COMPOSER_FOOTER_TIER_PROMOTION_SLACK_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  composerFooterMaxTier,
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
  it("maps tiers to the degradation order: context, reset, quota, traits, model, relocation", () => {
    expect(composerFooterPlanForTier(0, true, true)).toEqual({
      showContextMeter: true,
      showProviderUsageReset: true,
      showProviderUsage: true,
      showTraitsLabel: true,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(1, true, true)).toEqual({
      showContextMeter: false,
      showProviderUsageReset: true,
      showProviderUsage: true,
      showTraitsLabel: true,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(2, true, true)).toEqual({
      showContextMeter: false,
      showProviderUsageReset: false,
      showProviderUsage: true,
      showTraitsLabel: true,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(3, true, true)).toEqual({
      showContextMeter: false,
      showProviderUsageReset: false,
      showProviderUsage: false,
      showTraitsLabel: true,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(4, true, true)).toEqual({
      showContextMeter: false,
      showProviderUsageReset: false,
      showProviderUsage: false,
      showTraitsLabel: false,
      showModelLabel: true,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(5, true, true)).toEqual({
      showContextMeter: false,
      showProviderUsageReset: false,
      showProviderUsage: false,
      showTraitsLabel: false,
      showModelLabel: false,
      relocateLeadingControls: false,
    });
    expect(composerFooterPlanForTier(COMPOSER_FOOTER_MAX_TIER, true, true)).toEqual({
      showContextMeter: false,
      showProviderUsageReset: false,
      showProviderUsage: false,
      showTraitsLabel: false,
      showModelLabel: false,
      relocateLeadingControls: true,
    });
  });

  it("never shows the context meter when the thread has none", () => {
    expect(composerFooterPlanForTier(0, false).showContextMeter).toBe(false);
  });

  it("never reserves quota tiers when the active provider has no usage capability", () => {
    expect(
      Array.from({ length: 5 }, (_, tier) => composerFooterPlanForTier(tier, true, false)),
    ).toEqual([
      {
        showContextMeter: true,
        showProviderUsage: false,
        showProviderUsageReset: false,
        showTraitsLabel: true,
        showModelLabel: true,
        relocateLeadingControls: false,
      },
      {
        showContextMeter: false,
        showProviderUsage: false,
        showProviderUsageReset: false,
        showTraitsLabel: true,
        showModelLabel: true,
        relocateLeadingControls: false,
      },
      {
        showContextMeter: false,
        showProviderUsage: false,
        showProviderUsageReset: false,
        showTraitsLabel: false,
        showModelLabel: true,
        relocateLeadingControls: false,
      },
      {
        showContextMeter: false,
        showProviderUsage: false,
        showProviderUsageReset: false,
        showTraitsLabel: false,
        showModelLabel: false,
        relocateLeadingControls: false,
      },
      {
        showContextMeter: false,
        showProviderUsage: false,
        showProviderUsageReset: false,
        showTraitsLabel: false,
        showModelLabel: false,
        relocateLeadingControls: true,
      },
    ]);
    expect(composerFooterMaxTier(true, false)).toBe(4);
  });

  it("does not reserve a tier for a missing context meter", () => {
    expect(composerFooterPlanForTier(1, false, true).showProviderUsageReset).toBe(false);
    expect(composerFooterMaxTier(false, true)).toBe(5);
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

  it("stops at the active control set's max tier", () => {
    let demotionWidths: ReadonlyArray<number | undefined> = [];
    let tier = 0;
    const maxTier = composerFooterMaxTier(false, false);
    for (let pass = 0; pass < COMPOSER_FOOTER_MAX_TIER; pass += 1) {
      const step = resolveNextComposerFooterTier({
        currentTier: tier,
        clientWidth: 300,
        isOverflowing: true,
        demotionWidths,
        maxTier,
      });
      tier = step.tier;
      demotionWidths = step.demotionWidths;
    }
    expect(tier).toBe(3);
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
      demotionWidths: [400, 380, 360, 340, 320, 300],
    });
    expect(step.tier).toBe(0);
  });
});
