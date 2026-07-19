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
// Degradation order (first thing to go first): context-window meter -> quota
// reset suffix -> quota control -> traits/effort label (gear icon stays) ->
// model name (provider icon stays) -> relocate the leading controls (extras
// "+" menu, access-rules indicator) into the row below the input, next to the
// branch toolbar.
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
  showProviderUsage: boolean;
  showProviderUsageReset: boolean;
  showModelLabel: boolean;
  showTraitsLabel: boolean;
  relocateLeadingControls: boolean;
}

// The maximum applies when every optional control is present. Call
// composerFooterMaxTier for the active control set so absent controls do not
// create no-op measurement passes.
export const COMPOSER_FOOTER_MAX_TIER = 6;
// Extra width (px) required beyond the recorded overflow point before stepping
// back to a richer tier, so a 1px resize cannot oscillate between tiers.
export const COMPOSER_FOOTER_TIER_PROMOTION_SLACK_PX = 32;

export function composerFooterPlanForTier(
  tier: number,
  hasContextMeter: boolean,
  hasProviderUsage = false,
): ComposerFooterControlsPlan {
  let nextTier = 0;
  const showContextMeter = hasContextMeter && tier < (nextTier += 1);
  const showProviderUsageReset = hasProviderUsage && tier < (nextTier += 1);
  const showProviderUsage = hasProviderUsage && tier < (nextTier += 1);
  const showTraitsLabel = tier < (nextTier += 1);
  const showModelLabel = tier < (nextTier += 1);

  return {
    showContextMeter,
    showProviderUsageReset,
    showProviderUsage,
    showTraitsLabel,
    showModelLabel,
    relocateLeadingControls: tier >= nextTier + 1,
  };
}

export function composerFooterMaxTier(hasContextMeter: boolean, hasProviderUsage = false): number {
  return (hasContextMeter ? 1 : 0) + (hasProviderUsage ? 2 : 0) + 3;
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
  maxTier?: number;
}): ComposerFooterTierStep {
  const demotionWidths = [...input.demotionWidths];
  const maxTier = Math.max(
    0,
    Math.min(input.maxTier ?? COMPOSER_FOOTER_MAX_TIER, COMPOSER_FOOTER_MAX_TIER),
  );
  let tier = Math.max(0, Math.min(input.currentTier, maxTier));

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
  if (input.isOverflowing && tier < maxTier) {
    demotionWidths[tier] = input.clientWidth;
    tier += 1;
  }

  return { tier, demotionWidths };
}
