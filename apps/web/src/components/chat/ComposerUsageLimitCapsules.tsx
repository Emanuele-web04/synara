// FILE: ComposerUsageLimitCapsules.tsx
// Purpose: Provider usage limits above the composer. A reached limit opens a card on its
// own (like Claude Code's limit prompt and the cache-review card): reset time, usage
// windows, auto-resume switches, and Change model. Collapsing it leaves a capsule that
// reopens it; resuming and approaching-limit states stay compact capsules.
// The clock only re-renders labels; it never dispatches work.
// Layer: Chat composer UI
// Exports: ComposerUsageLimitCapsules, ComposerUsageLimitCard, usageLimitCardKey

import {
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationThread,
  type ProviderKind,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { type TimestampFormat, useAppSettings } from "~/appSettings";
import { useNowMs } from "~/hooks/useNowMs";
import {
  type UsageLimitRecoverySettingState,
  useUsageLimitRecoverySetting,
} from "~/hooks/useUsageLimitRecoverySetting";
import { useTranslation } from "~/i18n";
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  InfoIcon,
  PlusIcon,
  UsageGaugeIcon,
} from "~/lib/icons";
import type { RateLimitStatus } from "~/lib/rateLimitStatus";
import { formatRateLimitResetCountdown } from "~/lib/rateLimits";
import { serverAllProviderUsageQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "~/timestampFormat";
import { useProviderUsageMenuModel } from "../ProviderUsageMenuControl";
import { ProviderUsageLimitRows } from "../ProviderUsageLimitRows";
import { IconButton } from "../ui/icon-button";
import { LiveStatusSpinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { COMPOSER_CAPSULE_ACTION_CLASS_NAME, ComposerCapsule } from "./ComposerCapsule";
import { ComposerChoiceRow } from "./ComposerChoiceRow";
import { ComposerTipRow } from "./ComposerTipRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";

type UsageLimitRecovery = NonNullable<OrchestrationThread["usageLimitRecovery"]>;

const COUNTDOWN_REFRESH_MS = 15_000;
const WARNING_ICON_CLASS_NAME = "size-3.5 shrink-0 text-warning";

/** A reset within half a day reads as a bare time (a five-hour window past midnight is
 *  still "00:29"); a weekly reset carries its weekday. */
const RESET_TIME_ONLY_WITHIN_MS = 12 * 3_600_000;

/** Clock time in the user's timestamp format (the transcript's own helper). */
function formatResetTime(
  resetMs: number,
  nowMs: number,
  locale: string,
  timestampFormat: TimestampFormat,
): string {
  const iso = new Date(resetMs).toISOString();
  const time = formatShortTimestamp(iso, timestampFormat, locale);
  if (resetMs - nowMs <= RESET_TIME_ONLY_WITHIN_MS) return time;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(resetMs);
  return `${weekday} ${time}`;
}

interface UsageLimitInputs {
  /** Current quota state after the "show rate-limit warnings" preference. */
  rateLimitStatus: RateLimitStatus | null;
  /** The owning computer's durable wait, when one is armed and no turn is running. */
  recovery: UsageLimitRecovery | null;
}

type UsageLimitView =
  | { kind: "none" }
  | { kind: "warning"; status: RateLimitStatus }
  | { kind: "resuming" }
  | { kind: "awaiting-host" }
  | {
      kind: "limited";
      resetAt: string | undefined;
      resetTime: string | null;
      countdown: string;
    };

function useUsageLimitView({ rateLimitStatus, recovery }: UsageLimitInputs): UsageLimitView {
  const { t, formatLocale } = useTranslation();
  const { settings } = useAppSettings();
  const limited = rateLimitStatus?.status === "rejected";
  const active = limited || rateLimitStatus !== null || recovery !== null;
  const nowMs = useNowMs(active, COUNTDOWN_REFRESH_MS);
  if (recovery?.state === "resuming") return { kind: "resuming" };
  if (!limited && recovery === null) {
    return rateLimitStatus?.status === "allowed_warning"
      ? { kind: "warning", status: rateLimitStatus }
      : { kind: "none" };
  }
  // The armed wait owns the deadline; otherwise the provider's reported reset does.
  const resetAt = recovery?.resetAt ?? rateLimitStatus?.resetsAt;
  const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  const resetPending = Number.isFinite(resetMs) && resetMs > nowMs;
  if (recovery && !resetPending) return { kind: "awaiting-host" };
  return {
    kind: "limited",
    resetAt,
    resetTime: resetPending
      ? formatResetTime(resetMs, nowMs, formatLocale, settings.timestampFormat)
      : null,
    countdown: resetAt && resetPending ? formatRateLimitResetCountdown(resetAt, t) : "",
  };
}

/** Identity of one limit episode for the card's collapsed state: a new wait or a new
 *  reported reset reopens the card. */
export function usageLimitCardKey(
  threadId: string,
  { rateLimitStatus, recovery }: UsageLimitInputs,
): string | null {
  if (recovery === null && rateLimitStatus?.status !== "rejected") return null;
  return [threadId, recovery?.id ?? "", rateLimitStatus?.resetsAt ?? recovery?.resetAt ?? ""].join(
    "\u001f",
  );
}

function providerDisplayName(provider: ProviderKind | undefined): string | null {
  return provider ? PROVIDER_DISPLAY_NAMES[provider] : null;
}

interface ComposerUsageLimitCapsulesProps extends UsageLimitInputs {
  /** The approaching-limit tip is not dismissed and not shown elsewhere (Environment). */
  showWarning: boolean;
  /** The limit card is showing, so the capsule row stays quiet. */
  cardOpen: boolean;
  onOpenCard: () => void;
  onDismissWarning: () => void;
  onCancelRecovery: () => void;
}

/** Capsule-row presence: the approaching tip, live resume progress, or the collapsed card. */
export function ComposerUsageLimitCapsules({
  rateLimitStatus,
  recovery,
  showWarning,
  cardOpen,
  onOpenCard,
  onDismissWarning,
  onCancelRecovery,
}: ComposerUsageLimitCapsulesProps) {
  const { t, formatLocale } = useTranslation();
  const recoverySetting = useUsageLimitRecoverySetting();
  const view = useUsageLimitView({ rateLimitStatus, recovery });

  switch (view.kind) {
    case "none":
      return null;
    case "warning": {
      if (!showWarning) return null;
      const usage =
        typeof view.status.utilization === "number"
          ? new Intl.NumberFormat(formatLocale, {
              style: "percent",
              maximumFractionDigits: 0,
            }).format(view.status.utilization)
          : null;
      const countdown = view.status.resetsAt
        ? formatRateLimitResetCountdown(view.status.resetsAt, t)
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
    case "resuming":
      return (
        <ComposerCapsule
          icon={<LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
          testId="composer-usage-limit-capsule"
        >
          {t("chat:usageLimitResuming")}
        </ComposerCapsule>
      );
    case "awaiting-host":
      return (
        <ComposerCapsule
          icon={<ClockIcon aria-hidden className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
          testId="composer-usage-limit-capsule"
          actions={
            recoverySetting.supported ? (
              <CancelRecoveryAction onCancelRecovery={onCancelRecovery} />
            ) : undefined
          }
        >
          {t("chat:usageLimitAwaitingHost")}
        </ComposerCapsule>
      );
    case "limited":
      if (cardOpen) return null;
      return (
        <>
          <ComposerCapsule
            icon={<UsageGaugeIcon aria-hidden className={WARNING_ICON_CLASS_NAME} />}
            title={t("chat:usageLimit_showDetails")}
            ariaLabel={t("chat:usageLimit_showDetails")}
            testId="composer-usage-limit-capsule"
            onClick={onOpenCard}
          >
            {t("chat:usageLimit_reached")}
            {view.countdown ? (
              <span className="text-muted-foreground"> · {view.countdown}</span>
            ) : null}
          </ComposerCapsule>
          <AutoResumeChip
            recovery={recovery}
            resetTime={view.resetTime}
            recoverySetting={recoverySetting}
            onCancelRecovery={onCancelRecovery}
          />
        </>
      );
  }
}

function CancelRecoveryAction({ onCancelRecovery }: { onCancelRecovery: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={COMPOSER_CAPSULE_ACTION_CLASS_NAME}
      aria-label={t("chat:cancelUsageLimitResume")}
      onClick={onCancelRecovery}
    >
      {t("common:form_cancel")}
    </button>
  );
}

function enableAutoResume(
  recoverySetting: UsageLimitRecoverySettingState,
  translate: ReturnType<typeof useTranslation>["t"],
) {
  if (!recoverySetting.ready) return;
  void recoverySetting.setEnabled(true).then((updated) => {
    if (!updated) return;
    toastManager.add({
      type: "success",
      title: translate("chat:usageLimit_autoResumeOnToast"),
      description: translate("chat:usageLimit_autoResumeOnToastDescription"),
    });
  });
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
  if (!recoverySetting.supported) return null;

  if (recovery) {
    return (
      <ComposerCapsule
        icon={
          <CheckIcon aria-hidden className="size-3.5 shrink-0 text-[var(--color-text-accent)]" />
        }
        testId="composer-usage-limit-auto-resume"
        actions={<CancelRecoveryAction onCancelRecovery={onCancelRecovery} />}
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
        onClick={() => enableAutoResume(recoverySetting, t)}
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

interface ComposerUsageLimitCardProps extends UsageLimitInputs {
  provider: ProviderKind | undefined;
  instanceId: string | undefined;
  onCollapse: () => void;
  onCancelRecovery: () => void;
  onChangeModel?: (() => void) | undefined;
}

/** The reached-limit card: opens on its own, collapses into the capsule row. */
export function ComposerUsageLimitCard({
  provider,
  instanceId,
  rateLimitStatus,
  recovery,
  onCollapse,
  onCancelRecovery,
  onChangeModel,
}: ComposerUsageLimitCardProps) {
  const { t } = useTranslation();
  const recoverySetting = useUsageLimitRecoverySetting();
  const view = useUsageLimitView({ rateLimitStatus, recovery });
  if (view.kind !== "limited") return null;

  const providerName = providerDisplayName(provider);
  const armed = recovery !== null;
  const title = providerName
    ? t("chat:usageLimit_cardTitle", { provider: providerName })
    : t("chat:usageLimit_cardTitleNoProvider");
  const resetLine = view.resetTime
    ? view.countdown
      ? t("chat:usageLimit_cardResets", { time: view.resetTime, countdown: view.countdown })
      : t("chat:usageLimit_cardResetsAt", { time: view.resetTime })
    : null;
  const body = armed
    ? t("chat:usageLimit_cardArmed")
    : recoverySetting.supported && recoverySetting.enabled
      ? t("chat:usageLimit_cardUnarmed")
      : t("chat:usageLimit_cardManual");

  return (
    <section
      aria-label={title}
      data-testid="composer-usage-limit-card"
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-3.5 py-3")}
    >
      <div className="flex items-start gap-2.5">
        <UsageGaugeIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-ui-lg font-medium leading-snug text-foreground/90">{title}</p>
          <p className="mt-1 text-ui leading-relaxed text-muted-foreground">
            {resetLine ? <span className="text-foreground/80">{resetLine} </span> : null}
            {body}
          </p>
        </div>
        <IconButton
          variant="ghost"
          size="icon-chip"
          label={t("chat:usageLimit_collapse")}
          onClick={onCollapse}
        >
          <ChevronDownIcon />
        </IconButton>
      </div>
      {provider ? <UsageLimitWindows provider={provider} instanceId={instanceId} /> : null}
      <div className="mt-2.5 space-y-0.5">
        {recoverySetting.supported ? (
          <>
            <UsageLimitSwitchRow
              label={t("chat:usageLimit_resumeThisTask")}
              description={
                armed && view.resetTime
                  ? t("chat:usageLimit_resumeThisTaskArmed", { time: view.resetTime })
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
              onCheckedChange={(checked) =>
                checked
                  ? enableAutoResume(recoverySetting, t)
                  : void recoverySetting.setEnabled(false)
              }
            />
          </>
        ) : null}
        {onChangeModel ? (
          <ComposerChoiceRow
            shortcut={null}
            layout="stacked"
            label={t("chat:providerModelPicker_changeModel")}
            description={t("chat:usageLimit_changeModelDescription")}
            onSelect={onChangeModel}
          />
        ) : null}
      </div>
    </section>
  );
}

/** Same lane and padding as ComposerChoiceRow (stacked), with a switch instead of a chip. */
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
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors duration-150",
        disabled
          ? "cursor-default"
          : "cursor-pointer hover:bg-[var(--color-background-button-secondary-hover)]",
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-ui font-medium leading-5",
            disabled ? "text-muted-foreground" : "text-foreground/90",
          )}
        >
          {label}
        </span>
        <span className="block text-ui-sm leading-snug text-muted-foreground">{description}</span>
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
}): ReactNode {
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  // The thread can outlive its settings entry. Keep its quota scoped to the
  // original account while settings load or after an account is removed.
  const usageInstanceId = instanceId ?? provider;
  const snapshot = usageQuery.data?.find(
    (entry) =>
      entry.provider === provider && (entry.instanceId ?? entry.provider) === usageInstanceId,
  );
  const model = useProviderUsageMenuModel(provider, {
    instanceId: usageInstanceId,
    providerSnapshot: snapshot,
  });
  if (model.rows.length === 0) return null;
  return (
    <div className="mt-3 pl-[26px]">
      <ProviderUsageLimitRows rows={model.rows} surface="popover" />
    </div>
  );
}
