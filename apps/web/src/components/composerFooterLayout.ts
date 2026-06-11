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

// Progressive degradation for the footer's picker cluster.
// Degradation order (first thing to go first): context-window meter ->
// traits/effort label (gear icon stays) -> model name (provider icon stays) ->
// relocate the leading controls (extras "+" menu, access-rules indicator) into
// the row below the input, next to the branch toolbar.
//
// Visibility is driven by MEASURED overflow, not estimated widths: label
// lengths vary per provider/model and the app supports UI font scaling, so any
// static pixel estimate eventually lies. Instead the footer renders a tier,
// the caller re-measures, and the tier is demoted one step while the footer
// still overflows (converging in <= COMPOSER_FOOTER_MAX_TIER synchronous
// layout passes). The width at each demotion is remembered so widening the
// pane promotes back with hysteresis instead of flickering at the boundary.
export interface ComposerFooterControlsPlan {
  showContextMeter: boolean;
  showModelLabel: boolean;
  showTraitsLabel: boolean;
  relocateLeadingControls: boolean;
}

// Tier 0 = everything visible ... tier 3 = icons only, tier 4 = leading
// controls move below the input.
export const COMPOSER_FOOTER_MAX_TIER = 4;
// Extra width (px) required beyond the recorded overflow point before stepping
// back to a richer tier, so a 1px resize cannot oscillate between tiers.
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
  // Index i holds the footer clientWidth at which tier i last overflowed
  // (i.e. the width that forced the demotion from tier i to i + 1).
  demotionWidths: ReadonlyArray<number | undefined>;
}

export function resolveNextComposerFooterTier(input: {
  currentTier: number;
  clientWidth: number;
  // Whether the rendered footer content currently overflows. Callers must
  // also account for clusters that CLIP (overflow-hidden) rather than grow
  // the row's scrollWidth — e.g. the leading "+"/access-rules cluster.
  isOverflowing: boolean;
  demotionWidths: ReadonlyArray<number | undefined>;
}): ComposerFooterTierStep {
  const demotionWidths = [...input.demotionWidths];
  let tier = Math.max(0, Math.min(input.currentTier, COMPOSER_FOOTER_MAX_TIER));

  // Promote toward richer tiers while the footer is comfortably wider than the
  // width at which the richer tier last overflowed. An unknown demotion width
  // means that tier never overflowed, so promotion is always allowed.
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

  // Demote one step when the rendered content overflows; the caller re-renders
  // and re-measures, stepping again until the footer fits or tiers run out.
  if (input.isOverflowing && tier < COMPOSER_FOOTER_MAX_TIER) {
    demotionWidths[tier] = input.clientWidth;
    tier += 1;
  }

  return { tier, demotionWidths };
}
