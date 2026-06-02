import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

const APPROVAL_SECONDARY_BUTTON_CLASS_NAME =
  "border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)] hover:bg-[var(--color-background-button-secondary-hover)] data-pressed:bg-[var(--color-background-button-secondary-hover)]";

const APPROVAL_DECLINE_BUTTON_CLASS_NAME =
  "border-[color:color-mix(in_srgb,var(--destructive)_36%,var(--color-border))] bg-[color-mix(in_srgb,var(--destructive)_8%,var(--color-background-elevated-secondary))] text-destructive-foreground hover:border-[color:color-mix(in_srgb,var(--destructive)_52%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--destructive)_12%,var(--color-background-elevated-secondary))] data-pressed:bg-[color-mix(in_srgb,var(--destructive)_14%,var(--color-background-elevated-secondary))]";

const APPROVAL_PRIMARY_BUTTON_CLASS_NAME =
  "border-[color:color-mix(in_srgb,var(--color-accent-blue)_46%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent-blue)_16%,var(--color-background-elevated-secondary))] text-[var(--color-text-foreground)] hover:bg-[color-mix(in_srgb,var(--color-accent-blue)_22%,var(--color-background-elevated-secondary))] data-pressed:bg-[color-mix(in_srgb,var(--color-accent-blue)_26%,var(--color-background-elevated-secondary))]";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        className={APPROVAL_DECLINE_BUTTON_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        className={APPROVAL_SECONDARY_BUTTON_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        className={APPROVAL_PRIMARY_BUTTON_CLASS_NAME}
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
    </>
  );
});
