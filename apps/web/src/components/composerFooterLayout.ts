export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 720;

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

// progressive degradation driven by MEASURED overflow (label lengths vary, UI font scaling lies to static estimates); demotion widths are remembered so widening promotes back with hysteresis
export interface ComposerFooterControlsPlan {
  showContextMeter: boolean;
  showModelLabel: boolean;
  showTraitsLabel: boolean;
  relocateLeadingControls: boolean;
}

// tier 0 = everything visible ... tier 3 = icons only, tier 4 = leading controls move below the input
export const COMPOSER_FOOTER_MAX_TIER = 4;
// extra width required beyond the recorded overflow point before promoting, so a 1px resize can't oscillate
export const COMPOSER_FOOTER_TIER_PROMOTION_SLACK_PX = 32;

export function composerFooterPlanForTier(
  tier: number,
  hasContextMeter: boolean,
): ComposerFooterControlsPlan {
  return {
    showContextMeter: hasContextMeter && tier < 1,
    showTraitsLabel: tier < 2,
    showModelLabel: tier < 3,
    relocateLeadingControls: tier >= 4,
  };
}

export interface ComposerFooterTierStep {
  tier: number;
  // index i holds the clientWidth at which tier i last overflowed
  demotionWidths: ReadonlyArray<number | undefined>;
}

export function resolveNextComposerFooterTier(input: {
  currentTier: number;
  clientWidth: number;
  // callers must also account for clusters that CLIP (overflow-hidden) rather than grow scrollWidth — e.g. the leading "+"/access-rules cluster
  isOverflowing: boolean;
  demotionWidths: ReadonlyArray<number | undefined>;
}): ComposerFooterTierStep {
  const demotionWidths = [...input.demotionWidths];
  let tier = Math.max(0, Math.min(input.currentTier, COMPOSER_FOOTER_MAX_TIER));

  // promote while comfortably wider than the tier's last overflow width; unknown demotion width = never overflowed, always allowed
  while (tier > 0) {
    const richerTierOverflowedAt = demotionWidths[tier - 1];
    if (
      richerTierOverflowedAt !== undefined &&
      input.clientWidth < richerTierOverflowedAt + COMPOSER_FOOTER_TIER_PROMOTION_SLACK_PX
    ) {
      break;
    }
    tier -= 1;
  }

  // demote one step on overflow; the caller re-renders and re-measures until it fits or tiers run out
  if (input.isOverflowing && tier < COMPOSER_FOOTER_MAX_TIER) {
    demotionWidths[tier] = input.clientWidth;
    tier += 1;
  }

  return { tier, demotionWidths };
}
