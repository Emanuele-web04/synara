import type { ResolvedThreadWorkspaceState } from "@synara/shared/threadEnvironment";
import type { ProviderInteractionMode } from "@synara/contracts";
import type { DraftThreadEnvMode } from "../../composerDraftStore";
import {
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  formatCostUsd,
} from "../../lib/contextWindow";
import type { RateLimitStatus } from "./RateLimitBanner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { useTranslation, t } from "~/i18n";

function formatRateLimitMessage(
  rateLimitStatus: RateLimitStatus,
  translate: typeof t,
  formatLocale: string,
): string {
  const resetAt = rateLimitStatus.resetsAt
    ? new Date(rateLimitStatus.resetsAt).toLocaleTimeString(formatLocale)
    : null;
  if (rateLimitStatus.status === "rejected") {
    return resetAt
      ? translate("chat:rateLimitReachedReset", { resetAt })
      : translate("chat:rateLimitReachedNoReset");
  }
  const usage =
    typeof rateLimitStatus.utilization === "number"
      ? new Intl.NumberFormat(formatLocale, { style: "percent", maximumFractionDigits: 0 }).format(
          rateLimitStatus.utilization,
        )
      : null;
  if (usage !== null) {
    return resetAt
      ? translate("chat:rateLimitApproachingUsageReset", { usage, resetAt })
      : translate("chat:rateLimitApproachingUsage", { usage });
  }
  return resetAt
    ? translate("chat:rateLimitApproachingReset", { resetAt })
    : translate("chat:rateLimitApproaching");
}

function formatEnvironmentLabel(
  envMode: DraftThreadEnvMode,
  envState: ResolvedThreadWorkspaceState,
  translate: typeof t,
): string {
  if (envMode === "local") {
    return translate("computer:worktreeMode_local");
  }
  return envState === "worktree-pending"
    ? translate("chat:newWorktreePending")
    : translate("common:worktreeMode_worktree");
}

export function ComposerSlashStatusDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedModel: string | null | undefined;
  fastModeEnabled: boolean;
  selectedPromptEffort: string | null;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
  envState: ResolvedThreadWorkspaceState;
  branch: string | null;
  contextWindow: ContextWindowSnapshot | null;
  cumulativeCostUsd: number | null;
  rateLimitStatus: RateLimitStatus | null;
  activeContextWindowLabel?: string | null;
  pendingContextWindowLabel?: string | null;
}) {
  const { t, formatLocale } = useTranslation();

  const {
    open,
    onOpenChange,
    selectedModel,
    fastModeEnabled,
    selectedPromptEffort,
    interactionMode,
    envMode,
    envState,
    branch,
    contextWindow,
    cumulativeCostUsd,
    rateLimitStatus,
    activeContextWindowLabel,
    pendingContextWindowLabel,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("chat:sessionStatus_title")}</DialogTitle>
          <DialogDescription>
            {t("chat:runtimeControlsAndLocalThreadStateForTheActive")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 text-ui-lg leading-snug sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("chat:detail_model")}</p>
              <p className="font-medium text-foreground">{selectedModel}</p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("chat:fastMode")}</p>
              <p className="font-medium text-foreground">
                {fastModeEnabled
                  ? t("automation:modelEffort_thinkingOn")
                  : t("automation:traitsPicker_off")}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">
                {t("chat:sessionStatus_reasoning")}
              </p>
              <p className="font-medium text-foreground">
                {selectedPromptEffort ?? t("settings:reasoningModes_default")}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("chat:mode_label")}</p>
              <p className="font-medium text-foreground">
                {interactionMode === "plan"
                  ? t("workspace:plan_badge")
                  : interactionMode === "debug"
                    ? t("chat:debug")
                    : t("settings:reasoningModes_default")}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">
                {t("chat:general_environmentPanel")}
              </p>
              <p className="font-medium text-foreground">
                {formatEnvironmentLabel(envMode, envState, t)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">
                {t("common:sessionStatus_branch")}
              </p>
              <p className="font-medium text-foreground">{branch ?? t("common:common_unknown")}</p>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-ui leading-snug text-muted-foreground">
                  {t("chat:contextWindow")}
                </p>
                <p className="text-ui leading-snug text-muted-foreground">
                  {t("chat:latestUsageReportedByTheActiveThread")}
                </p>
                {pendingContextWindowLabel ? (
                  <p className="text-ui leading-snug text-muted-foreground">
                    {t("chat:sessionStatus_currentSessionLabel")}{" "}
                    {activeContextWindowLabel ?? t("common:common_unknown")}
                    {t("chat:nextTurn")} {pendingContextWindowLabel}.
                  </p>
                ) : null}
              </div>
              {contextWindow ? (
                <ContextWindowMeter
                  usage={contextWindow}
                  cumulativeCostUsd={cumulativeCostUsd}
                  activeWindowLabel={activeContextWindowLabel}
                  pendingWindowLabel={pendingContextWindowLabel}
                />
              ) : null}
            </div>
            <div className="grid gap-3 text-ui-lg leading-snug sm:grid-cols-2">
              {contextWindow ? (
                <>
                  <div>
                    <p className="text-muted-foreground">{t("chat:sessionStatus_used")}</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.usedTokens)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{t("chat:sessionStatus_remaining")}</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.remainingTokens)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{t("common:sessionStatus_window")}</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.maxTokens)}
                    </p>
                  </div>
                </>
              ) : (
                <div>
                  <p className="text-muted-foreground">{t("chat:contextUsage")}</p>
                  <p className="font-medium text-foreground">{t("chat:notReportedYet")}</p>
                </div>
              )}
              <div>
                <p className="text-muted-foreground">{t("chat:sessionStatus_cost")}</p>
                <p className="font-medium text-foreground">
                  {cumulativeCostUsd !== null
                    ? formatCostUsd(cumulativeCostUsd)
                    : t("chat:notAvailable")}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border/60 bg-card p-4">
            <p className="text-ui leading-snug text-muted-foreground">{t("chat:rateLimits")}</p>
            {rateLimitStatus ? (
              <p className="text-ui leading-snug text-foreground">
                {formatRateLimitMessage(rateLimitStatus, t, formatLocale)}
              </p>
            ) : (
              <p className="text-ui leading-snug text-muted-foreground">
                {t("chat:noActiveRateLimitWarningForThisThread")}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {t("common:app_close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
