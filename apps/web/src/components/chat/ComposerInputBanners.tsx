// FILE: ComposerInputBanners.tsx
// Purpose: Picks which prompt (if any) renders inside the composer surface — a plan
// follow-up or automation setup prompt. Detached notices and decision cards render
// above the composer instead of sharing this fused surface.
// Layer: Chat composer UI
// Exports: ComposerInputBanners

import { type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ComposerAutomationSetupBanner } from "./ComposerAutomationSetupBanner";
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
}

export function ComposerInputBanners({
  roundedTopReset,
  planFollowUp,
  automationSetup,
}: ComposerInputBannersProps) {
  let content: ReactNode = null;
  if (planFollowUp) {
    content = <ComposerPlanFollowUpBanner key={planFollowUp.id} planTitle={planFollowUp.title} />;
  } else if (automationSetup) {
    content = <ComposerAutomationSetupBanner onCancel={automationSetup.onCancel} />;
  }

  if (!content) {
    return null;
  }

  return (
    <div
      className={cn(COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME, roundedTopReset && "!rounded-t-none")}
    >
      {content}
    </div>
  );
}
