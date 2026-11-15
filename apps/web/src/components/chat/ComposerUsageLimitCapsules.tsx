// FILE: ComposerUsageLimitCapsules.tsx
// Purpose: Provider usage limits as composer capsules. Approaching a limit is a dismissible
// tip; a reached limit is one capsule whose popover holds the usage windows and the
// auto-resume controls, plus a chip that mirrors the owning computer's durable wait.
// The clock only re-renders labels; it never dispatches work.
// Layer: Chat composer UI
// Exports: ComposerUsageLimitCapsules

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationThread,
  type ProviderKind,
} from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useNowMs } from "~/hooks/useNowMs";
import {
  type UsageLimitRecoverySettingState,
  useUsageLimitRecoverySetting,
} from "~/hooks/useUsageLimitRecoverySetting";
import { useTranslation } from "~/i18n";
import { CheckIcon, ClockIcon, InfoIcon, PlusIcon, UsageGaugeIcon } from "~/lib/icons";
import type { RateLimitStatus } from "~/lib/rateLimitStatus";
import { formatRateLimitResetCountdown } from "~/lib/rateLimits";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useProviderUsageMenuModel } from "../ProviderUsageMenuControl";
import { ProviderUsageLimitRows } from "../ProviderUsageLimitRows";
import { Button } from "../ui/button";
import { LiveStatusSpinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  COMPOSER_CAPSULE_ACTION_CLASS_NAME,
  ComposerCapsule,
  ComposerCapsulePopover,
} from "./ComposerCapsule";
import { ComposerTipRow } from "./ComposerTipRow";
import {
  COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
} from "./composerStackedPanelStyles";

type UsageLimitRecovery = NonNullable<OrchestrationThread["usageLimitRecovery"]>;

const COUNTDOWN_REFRESH_MS = 15_000;
const WARNING_ICON_CLASS_NAME = "size-3.5 shrink-0 text-warning";

/** A reset within half a day reads as a bare time (a five-hour window past midnight is
 *  still "00:29"); a weekly reset carries its weekday. */
const RESET_TIME_ONLY_WITHIN_MS = 12 * 3_600_000;

function formatResetTime(resetMs: number, nowMs: number, locale: string): string {
  const timeOnly = resetMs - nowMs <= RESET_TIME_ONLY_WITHIN_MS;
  return new Intl.DateTimeFormat(locale, {
    ...(timeOnly ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(resetMs);
}

interface ComposerUsageLimitCapsulesProps {
  provider: ProviderKind | undefined;
  instanceId: string | undefined;
  /** Current quota state after the "show rate-limit warnings" preference. */
  rateLimitStatus: RateLimitStatus | null;
  /** The approaching-limit tip is not dismissed and not shown elsewhere (Environment). */
  showWarning: boolean;
  /** The owning computer's durable wait, when one is armed and no turn is running. */
  recovery: UsageLimitRecovery | null;
  onDismissWarning: () => void;
  onCancelRecovery: () => void;
  onChangeModel?: (() => void) | undefined;
}

export function ComposerUsageLimitCapsules({
  provider,
  instanceId,
  rateLimitStatus,
  showWarning,
  recovery,
  onDismissWarning,
  onCancelRecovery,
  onChangeModel,
}: ComposerUsageLimitCapsulesProps) {
  const { t, formatLocale } = useTranslation();
  const recoverySetting = useUsageLimitRecoverySetting();
  const limited = rateLimitStatus?.status === "rejected";
  const warning = rateLimitStatus?.status === "allowed_warning" && showWarning;
  const nowMs = useNowMs(limited || warning || recovery !== null, COUNTDOWN_REFRESH_MS);

  if (!limited && recovery === null) {
    if (!warning || !rateLimitStatus) return null;
    const usage =
      typeof rateLimitStatus.utilization === "number"
        ? new Intl.NumberFormat(formatLocale, {
            style: "percent",
            maximumFractionDigits: 0,
          }).format(rateLimitStatus.utilization)
        : null;
    const countdown = rateLimitStatus.resetsAt
      ? formatRateLimitResetCountdown(rateLimitStatus.resetsAt, t)
      : "";
    return (
      <ComposerTipRow
        icon={<UsageGaugeIcon aria-hidden className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
        message={
          <>
            {usage ? t("chat:usageLimit_used", { usage }) : t("chat:usageLimit_approaching")}
            {countdown ? <span className="text-muted-foreground"> · {countdown}</span> : null}
          </>
        }
        onDismiss={onDismissWarning}
        dismissLabel={t("chat:rateLimit_dismissStatus")}
        testId="composer-usage-limit-warning"
      />
    );
  }

  // The armed wait owns the deadline; otherwise the provider's reported reset does.
  const resetAt = recovery?.resetAt ?? rateLimitStatus?.resetsAt;
  const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  const resetPending = Number.isFinite(resetMs) && resetMs > nowMs;
  const resetTime = Number.isFinite(resetMs) ? formatResetTime(resetMs, nowMs, formatLocale) : null;
  const countdown = resetAt && resetPending ? formatRateLimitResetCountdown(resetAt, t) : "";
  const providerName = provider ? PROVIDER_DISPLAY_NAMES[provider] : null;

  let icon: ReactNode;
  let label: ReactNode;
  if (recovery?.state === "resuming") {
    icon = <LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />;
    label = t("chat:usageLimitResuming");
  } else if (recovery && !resetPending) {
    icon = <ClockIcon aria-hidden className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />;
    label = t("chat:usageLimitAwaitingHost");
  } else {
    icon = <UsageGaugeIcon aria-hidden className={WARNING_ICON_CLASS_NAME} />;
    label = (
      <>
        {t("chat:usageLimit_reached")}
        {countdown ? <span className="text-muted-foreground"> · {countdown}</span> : null}
      </>
    );
  }

  return (
    <>
      <ComposerCapsulePopover
        icon={icon}
        label={label}
        title={
          providerName
            ? t("chat:usageLimit_popoverTitle", { provider: providerName })
            : t("chat:usageLimit_popoverTitleNoProvider")
        }
        testId="composer-usage-limit-capsule"
        popupTestId="composer-usage-limit-popover"
      >
        {(close) => (
          <UsageLimitPopoverContent
            provider={provider}
            providerName={providerName}
            instanceId={instanceId}
            resetTime={resetPending ? resetTime : null}
            recovery={recovery}
            recoverySetting={recoverySetting}
            onCancelRecovery={onCancelRecovery}
            {...(onChangeModel
              ? {
                  onChangeModel: () => {
                    close();
                    onChangeModel();
                  },
                }
              : {})}
          />
        )}
      </ComposerCapsulePopover>
      <AutoResumeChip
        recovery={recovery}
        resetTime={resetTime}
        recoverySetting={recoverySetting}
        onCancelRecovery={onCancelRecovery}
      />
    </>
  );
}

function AutoResumeChip({
  recovery,
  resetTime,
  recoverySetting,
  onCancelRecovery,
}: {
  recovery: UsageLimitRecovery | null;
  resetTime: string | null;
  recoverySetting: UsageLimitRecoverySettingState;
  onCancelRecovery: () => void;
}) {
  const { t } = useTranslation();
  if (!recoverySetting.supported || recovery?.state === "resuming") return null;

  if (recovery) {
    return (
      <ComposerCapsule
        icon={
          <CheckIcon aria-hidden className="size-3.5 shrink-0 text-[var(--color-text-accent)]" />
        }
        testId="composer-usage-limit-auto-resume"
        actions={
          <button
            type="button"
            className={COMPOSER_CAPSULE_ACTION_CLASS_NAME}
            aria-label={t("chat:cancelUsageLimitResume")}
            onClick={onCancelRecovery}
          >
            {t("common:form_cancel")}
          </button>
        }
      >
        {resetTime
          ? t("chat:usageLimit_autoResumeAt", { time: resetTime })
          : t("chat:usageLimit_autoResume")}
      </ComposerCapsule>
    );
  }

  if (!recoverySetting.enabled) {
    return (
      <ComposerCapsule
        icon={<PlusIcon aria-hidden className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
        className="border-dashed"
        title={t("chat:usageLimit_enableAutoResumeTitle")}
        testId="composer-usage-limit-auto-resume"
        onClick={() => {
          if (!recoverySetting.ready) return;
          void recoverySetting.setEnabled(true).then((updated) => {
            if (!updated) return;
            toastManager.add({
              type: "success",
              title: t("chat:usageLimit_autoResumeOnToast"),
              description: t("chat:usageLimit_autoResumeOnToastDescription"),
            });
          });
        }}
      >
        {t("chat:usageLimit_autoResume")}
      </ComposerCapsule>
    );
  }

  return (
    <ComposerCapsule
      icon={<InfoIcon aria-hidden className="size-3.5 shrink-0" />}
      className="text-muted-foreground"
      title={t("chat:usageLimit_autoResumeUnavailableTitle")}
      testId="composer-usage-limit-auto-resume"
    >
      {t("chat:usageLimit_autoResumeUnavailable")}
    </ComposerCapsule>
  );
}

function UsageLimitPopoverContent({
  provider,
  providerName,
  instanceId,
  resetTime,
  recovery,
  recoverySetting,
  onCancelRecovery,
  onChangeModel,
}: {
  provider: ProviderKind | undefined;
  providerName: string | null;
  instanceId: string | undefined;
  resetTime: string | null;
  recovery: UsageLimitRecovery | null;
  recoverySetting: UsageLimitRecoverySettingState;
  onCancelRecovery: () => void;
  onChangeModel?: () => void;
}) {
  const { t } = useTranslation();
  const armed = recovery !== null && recovery.state !== "resuming";

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
        <div className="text-ui font-medium text-foreground">
          {providerName
            ? t("chat:usageLimit_popoverTitle", { provider: providerName })
            : t("chat:usageLimit_popoverTitleNoProvider")}
        </div>
        <p className="text-ui-sm text-muted-foreground">
          {resetTime
            ? t("chat:usageLimit_popoverResetsAt", { time: resetTime })
            : t("chat:usageLimit_popoverNoReset")}
        </p>
      </div>
      {provider ? <UsageLimitWindows provider={provider} instanceId={instanceId} /> : null}
      {recoverySetting.supported ? (
        <div className={cn(COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME, "flex flex-col py-1")}>
          <UsageLimitSwitchRow
            label={t("chat:usageLimit_resumeThisTask")}
            description={
              armed && resetTime
                ? t("chat:usageLimit_resumeThisTaskArmed", { time: resetTime })
                : armed
                  ? t("chat:usageLimitAwaitingHost")
                  : t("chat:usageLimit_resumeThisTaskUnavailable")
            }
            checked={armed}
            disabled={!armed}
            onCheckedChange={(checked) => {
              if (!checked) onCancelRecovery();
            }}
          />
          <UsageLimitSwitchRow
            label={t("chat:usageLimit_alwaysResume")}
            description={t("chat:usageLimit_alwaysResumeDescription")}
            checked={recoverySetting.enabled}
            disabled={!recoverySetting.ready}
            onCheckedChange={(checked) => void recoverySetting.setEnabled(checked)}
          />
        </div>
      ) : null}
      {onChangeModel ? (
        <div className={cn(COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME, "px-2.5 py-2")}>
          <Button size="xs" variant="outline" onClick={onChangeModel}>
            {t("chat:providerModelPicker_changeModel")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function UsageLimitSwitchRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-3 rounded-md px-2.5 py-1.5",
        disabled
          ? "cursor-default"
          : "cursor-pointer hover:bg-[var(--color-background-button-secondary-hover)]",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-ui", disabled ? "text-muted-foreground" : "text-foreground")}>
          {label}
        </span>
        <span className="text-ui-sm text-muted-foreground">{description}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(Boolean(next))}
        aria-label={label}
      />
    </label>
  );
}

/** Live usage windows for the limited account, from the same snapshot as Environment → Usage. */
function UsageLimitWindows({
  provider,
  instanceId,
}: {
  provider: ProviderKind;
  instanceId: string | undefined;
}) {
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const instance = deriveProviderInstances(settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW).find(
    (candidate) =>
      candidate.driver === provider && candidate.instanceId === (instanceId ?? provider),
  );
  const snapshot = usageQuery.data?.find(
    (entry) =>
      entry.provider === provider &&
      (entry.instanceId ?? entry.provider) === (instance?.instanceId ?? provider),
  );
  const model = useProviderUsageMenuModel(provider, {
    instanceId: instance?.instanceId,
    providerSnapshot: snapshot,
  });
  if (model.rows.length === 0) return null;
  return (
    <div className={cn(COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME, "px-2.5 py-2")}>
      <ProviderUsageLimitRows rows={model.rows} surface="popover" />
    </div>
  );
}
