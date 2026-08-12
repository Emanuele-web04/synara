// FILE: ComposerInputBanners.tsx
// Purpose: Picks the goal and contextual banners that render inside the composer surface.
// Pending approvals and AskUserQuestion prompts render as detached cards above the composer
// (see ComposerPendingApprovalPanel / ComposerPendingUserInputPanel), not here. Centralizes
// precedence and shared banner chrome so callers pass data, not layout.
// Layer: Chat composer UI
// Exports: ComposerInputBanners

import { type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ComposerAutomationSetupBanner } from "./ComposerAutomationSetupBanner";
import { ComposerGoalBanner } from "./ComposerGoalBanner";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME } from "./composerPickerStyles";

interface ComposerInputBannersProps {
  // Drop the rounded top when rows are stacked above the composer so the banner sits
  // flush under them.
  roundedTopReset: boolean;
  // `id` keys the banner so it remounts when the proposed plan changes.
  planFollowUp: { id: string; title: string | null } | null;
  // Setup-mode control while gathering an automation's task/schedule (the exchange
  // itself renders as bubbles in the transcript).
  automationSetup: { onCancel: () => void } | null;
  goal: { text: string; onClear: () => void | Promise<void> } | null;
}

export function ComposerInputBanners({
  roundedTopReset,
  planFollowUp,
  automationSetup,
  goal,
}: ComposerInputBannersProps) {
  let content: ReactNode = null;
  if (planFollowUp) {
    content = <ComposerPlanFollowUpBanner key={planFollowUp.id} planTitle={planFollowUp.title} />;
  } else if (automationSetup) {
    content = <ComposerAutomationSetupBanner onCancel={automationSetup.onCancel} />;
  }

  if (!content && !goal) {
    return null;
  }

  return (
    <div
      className={cn(
        COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME,
        "divide-y divide-[color:var(--color-border-light)]",
        roundedTopReset && "!rounded-t-none",
      )}
    >
      {goal ? <ComposerGoalBanner goal={goal.text} onClear={goal.onClear} /> : null}
      {content}
    </div>
  );
}
