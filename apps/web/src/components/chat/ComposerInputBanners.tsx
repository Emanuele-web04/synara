// FILE: ComposerInputBanners.tsx
// Purpose: Picks which banner (if any) renders above the composer editor — a pending
// approval, a pending user-input question, or a plan follow-up prompt. Centralizes
// the precedence and the shared banner chrome so callers pass data, not layout.
// Layer: Chat composer UI
// Exports: ComposerInputBanners

import { type ComponentProps, memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ComposerAutomationSetupBanner } from "./ComposerAutomationSetupBanner";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME } from "./composerPickerStyles";

type ApprovalProp = ComponentProps<typeof ComposerPendingApprovalPanel>["approval"];
type PendingUserInputPanelProps = ComponentProps<typeof ComposerPendingUserInputPanel>;

interface ComposerInputBannersProps {
  // Drop the rounded top when rows are stacked above the composer so the banner sits
  // flush under them.
  roundedTopReset: boolean;
  activeApproval: ApprovalProp | null;
  pendingApprovalCount: number;
  pendingUserInputs: PendingUserInputPanelProps["pendingUserInputs"];
  respondingUserInputRequestIds: PendingUserInputPanelProps["respondingRequestIds"];
  pendingUserInputAnswers: PendingUserInputPanelProps["answers"];
  pendingUserInputQuestionIndex: PendingUserInputPanelProps["questionIndex"];
  onToggleUserInputOption: PendingUserInputPanelProps["onToggleOption"];
  onAdvanceUserInput: PendingUserInputPanelProps["onAdvance"];
  onCancelUserInput: PendingUserInputPanelProps["onCancel"];
  // `id` keys the banner so it remounts when the proposed plan changes.
  planFollowUp: { id: string; title: string | null } | null;
  // Setup-mode control while gathering an automation's task/schedule (the exchange
  // itself renders as bubbles in the transcript).
  automationSetup: { onCancel: () => void } | null;
}

export const ComposerInputBanners = memo(function ComposerInputBanners({
  roundedTopReset,
  activeApproval,
  pendingApprovalCount,
  pendingUserInputs,
  respondingUserInputRequestIds,
  pendingUserInputAnswers,
  pendingUserInputQuestionIndex,
  onToggleUserInputOption,
  onAdvanceUserInput,
  onCancelUserInput,
  planFollowUp,
  automationSetup,
}: ComposerInputBannersProps) {
  let content: ReactNode = null;
  if (activeApproval) {
    content = (
      <ComposerPendingApprovalPanel approval={activeApproval} pendingCount={pendingApprovalCount} />
    );
  } else if (pendingUserInputs.length > 0) {
    content = (
      <ComposerPendingUserInputPanel
        pendingUserInputs={pendingUserInputs}
        respondingRequestIds={respondingUserInputRequestIds}
        answers={pendingUserInputAnswers}
        questionIndex={pendingUserInputQuestionIndex}
        onToggleOption={onToggleUserInputOption}
        onAdvance={onAdvanceUserInput}
        onCancel={onCancelUserInput}
      />
    );
  } else if (planFollowUp) {
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
});
