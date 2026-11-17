// FILE: UsageLimitPauseDivider.tsx
// Purpose: Mark a turn the provider refused for quota as a pause boundary in the transcript.
// Layer: Chat transcript UI
// Why: A usage limit is expected and recoverable, so it reads like the fork and handoff
//      boundaries instead of a red failure card. The composer's usage-limit capsule owns
//      the reset time and auto-resume; this row only records where the task stopped.

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { memo } from "react";

import { useTranslation } from "~/i18n";
import { PauseOutlineIcon } from "~/lib/icons";
import type { TimestampFormat } from "../../appSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { TranscriptDividerRule } from "./TranscriptDividerRule";

export const UsageLimitPauseDivider = memo(function UsageLimitPauseDivider({
  provider,
  createdAt,
  cause,
  timestampFormat,
  onContinue,
  continueDisabled,
}: {
  readonly provider: string | undefined;
  readonly createdAt: string;
  /** The provider's own wording, kept as the row's tooltip. */
  readonly cause: string;
  readonly timestampFormat: TimestampFormat;
  readonly onContinue?: (() => void) | undefined;
  readonly continueDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const providerName = provider
    ? (PROVIDER_DISPLAY_NAMES as Readonly<Record<string, string | undefined>>)[provider]
    : undefined;
  const time = formatShortTimestamp(createdAt, timestampFormat);

  return (
    <div
      data-usage-limit-pause="true"
      className="flex w-full items-center gap-4 py-3 font-system-ui"
    >
      <TranscriptDividerRule />
      <span className="inline-flex min-w-0 shrink items-center gap-2 text-ui-sm text-muted-foreground">
        <PauseOutlineIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate" title={cause}>
          {providerName
            ? t("chat:usageLimit_pausedAt", { provider: providerName, time })
            : t("chat:usageLimit_pausedAtNoProvider", { time })}
        </span>
        {onContinue ? (
          <Button size="xs" variant="ghost" disabled={continueDisabled} onClick={onContinue}>
            {t("chat:continueTask")}
          </Button>
        ) : null}
      </span>
      <TranscriptDividerRule />
    </div>
  );
});
