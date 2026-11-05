// FILE: ComposerUsageLimitRecovery.tsx
// Purpose: Mirror the owning computer's durable wait; the clock never dispatches work.

import type { OrchestrationThread } from "@synara/contracts";
import { useNowMs } from "~/hooks/useNowMs";
import { useTranslation } from "~/i18n";
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
  const { t, formatLocale } = useTranslation();
  const now = useNowMs(true, 15_000);
  const resetAt = Date.parse(recovery.resetAt);
  const label =
    recovery.state === "resuming"
      ? t("chat:usageLimitResuming")
      : Number.isFinite(resetAt) && resetAt > now
        ? t("chat:usageLimitResumeAt", {
            time: new Intl.DateTimeFormat(formatLocale, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }).format(resetAt),
          })
        : t("chat:usageLimitAwaitingHost");

  return (
    <ComposerCapsule
      icon={<ClockIcon aria-hidden className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      title={label}
      testId="composer-usage-limit-recovery"
      actions={
        <button type="button" className={COMPOSER_CAPSULE_ACTION_CLASS_NAME} onClick={onCancel}>
          {t("chat:cancelUsageLimitResume")}
        </button>
      }
    >
      <time dateTime={recovery.resetAt}>{label}</time>
    </ComposerCapsule>
  );
}
