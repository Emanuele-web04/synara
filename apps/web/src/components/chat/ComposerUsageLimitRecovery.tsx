// FILE: ComposerUsageLimitRecovery.tsx
// Purpose: Mirror the owning computer's durable wait; the clock never dispatches work.

import type { OrchestrationThread } from "@synara/contracts";
import { useNowMs } from "~/hooks/useNowMs";
import { ClockIcon } from "~/lib/icons";
import { ComposerCapsule, COMPOSER_CAPSULE_ACTION_CLASS_NAME } from "./ComposerCapsule";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerUsageLimitRecoveryProps {
  recovery: NonNullable<OrchestrationThread["usageLimitRecovery"]>;
  onCancel: () => void;
}

export function ComposerUsageLimitRecovery({
  recovery,
  onCancel,
}: ComposerUsageLimitRecoveryProps) {
  const now = useNowMs(true, 15_000);
  const resetAt = Date.parse(recovery.resetAt);
  const label =
    recovery.state === "resuming"
      ? "Continuing on your computer…"
      : Number.isFinite(resetAt) && resetAt > now
        ? `Usage limit · resumes at ${new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).format(resetAt)}`
        : "Usage reset reached · waiting for computer";

  return (
    <ComposerCapsule
      icon={<ClockIcon aria-hidden className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      title={label}
      testId="composer-usage-limit-recovery"
      actions={
        <button type="button" className={COMPOSER_CAPSULE_ACTION_CLASS_NAME} onClick={onCancel}>
          Cancel auto-resume
        </button>
      }
    >
      <time dateTime={recovery.resetAt}>{label}</time>
    </ComposerCapsule>
  );
}
