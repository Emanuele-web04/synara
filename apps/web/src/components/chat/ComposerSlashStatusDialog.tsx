import type { ResolvedThreadWorkspaceState } from "@t3tools/shared/threadEnvironment";
import type { ProviderInteractionMode } from "@t3tools/contracts";
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
import { useTranslation } from "react-i18next";

function formatRateLimitMessage(
  rateLimitStatus: RateLimitStatus,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const resetSuffix = rateLimitStatus.resetsAt
    ? ` ${t("chat.sessionStatus.resetsAt")} ${new Date(rateLimitStatus.resetsAt).toLocaleTimeString()}.`
    : "";
  if (rateLimitStatus.status === "rejected") {
    return t("chat.sessionStatus.rateLimitReached") + resetSuffix;
  }
  const utilizationSuffix =
    typeof rateLimitStatus.utilization === "number"
      ? ` (${Math.round(rateLimitStatus.utilization * 100)}${t("chat.sessionStatus.percentUsed")})`
      : "";
  return t("chat.sessionStatus.approachingRateLimit") + utilizationSuffix + resetSuffix;
}

function formatEnvironmentLabel(
  envMode: DraftThreadEnvMode,
  envState: ResolvedThreadWorkspaceState,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (envMode === "local") {
    return t("chat.sessionStatus.local");
  }
  return envState === "worktree-pending"
    ? t("chat.sessionStatus.newWorktreePending")
    : t("chat.sessionStatus.worktree");
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
  const { t } = useTranslation();
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
          <DialogTitle>{t("chat.sessionStatus.title")}</DialogTitle>
          <DialogDescription>{t("chat.sessionStatus.description")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("chat.sessionStatus.model")}</p>
              <p className="font-medium text-foreground">{selectedModel}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("chat.sessionStatus.fastMode")}</p>
              <p className="font-medium text-foreground">
                {fastModeEnabled ? t("common.on") : t("common.off")}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("chat.sessionStatus.reasoning")}</p>
              <p className="font-medium text-foreground">
                {selectedPromptEffort ?? t("common.default")}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("chat.sessionStatus.mode")}</p>
              <p className="font-medium text-foreground">
                {interactionMode === "plan" ? t("chat.sessionStatus.plan") : t("common.default")}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("chat.sessionStatus.environment")}</p>
              <p className="font-medium text-foreground">
                {formatEnvironmentLabel(envMode, envState, t)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("chat.sessionStatus.branch")}</p>
              <p className="font-medium text-foreground">{branch ?? t("common.unknown")}</p>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("chat.sessionStatus.contextWindow")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("chat.sessionStatus.contextWindowDescription")}
                </p>
                {pendingContextWindowLabel ? (
                  <p className="text-sm text-muted-foreground">
                    {t("chat.sessionStatus.currentSessionLabel")}{" "}
                    {activeContextWindowLabel ?? t("common.unknown")}.{" "}
                    {t("chat.sessionStatus.nextTurn")} {pendingContextWindowLabel}.
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
            {contextWindow ? (
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground">{t("chat.sessionStatus.used")}</p>
                  <p className="font-medium text-foreground">
                    {formatContextWindowTokens(contextWindow.usedTokens)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t("chat.sessionStatus.remaining")}</p>
                  <p className="font-medium text-foreground">
                    {formatContextWindowTokens(contextWindow.remainingTokens)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t("chat.sessionStatus.window")}</p>
                  <p className="font-medium text-foreground">
                    {formatContextWindowTokens(contextWindow.maxTokens)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t("chat.sessionStatus.cost")}</p>
                  <p className="font-medium text-foreground">
                    {cumulativeCostUsd !== null
                      ? formatCostUsd(cumulativeCostUsd)
                      : t("common.notAvailable")}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("chat.sessionStatus.noContextReported")}
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-lg border border-border/60 bg-card p-4">
            <p className="text-xs text-muted-foreground">{t("chat.sessionStatus.rateLimits")}</p>
            {rateLimitStatus ? (
              <p className="text-sm text-foreground">
                {formatRateLimitMessage(rateLimitStatus, t)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("chat.sessionStatus.noRateLimitWarning")}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
