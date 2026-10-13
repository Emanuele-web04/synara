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

function formatRateLimitMessage(rateLimitStatus: RateLimitStatus): string {
  const resetSuffix = rateLimitStatus.resetsAt
    ? ` Resets at ${new Date(rateLimitStatus.resetsAt).toLocaleTimeString()}.`
    : "";
  if (rateLimitStatus.status === "rejected") {
    return t("Rate limit reached.{{value0}}", { value0: resetSuffix });
  }
  const utilizationSuffix =
    typeof rateLimitStatus.utilization === "number"
      ? ` (${Math.round(rateLimitStatus.utilization * 100)}% used)`
      : "";
  return t("Approaching rate limit{{value0}}.{{value1}}", {
    value0: utilizationSuffix,
    value1: resetSuffix,
  });
}

function formatEnvironmentLabel(
  envMode: DraftThreadEnvMode,
  envState: ResolvedThreadWorkspaceState,
): string {
  if (envMode === "local") {
    return t("Local");
  }
  return envState === "worktree-pending" ? t("New worktree (pending)") : t("Worktree");
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
          <DialogTitle>{t("Session Status")}</DialogTitle>
          <DialogDescription>
            {t("Runtime controls and local thread state for the active composer.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 text-ui-lg leading-snug sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("Model")}</p>
              <p className="font-medium text-foreground">{selectedModel}</p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("Fast Mode")}</p>
              <p className="font-medium text-foreground">{fastModeEnabled ? t("On") : t("Off")}</p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("Reasoning")}</p>
              <p className="font-medium text-foreground">{selectedPromptEffort ?? t("Default")}</p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("Mode")}</p>
              <p className="font-medium text-foreground">
                {interactionMode === "plan"
                  ? t("Plan")
                  : interactionMode === "debug"
                    ? t("Debug")
                    : t("Default")}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("Environment")}</p>
              <p className="font-medium text-foreground">
                {formatEnvironmentLabel(envMode, envState)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-ui leading-snug text-muted-foreground">{t("Branch")}</p>
              <p className="font-medium text-foreground">{branch ?? t("Unknown")}</p>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-ui leading-snug text-muted-foreground">{t("Context Window")}</p>
                <p className="text-ui leading-snug text-muted-foreground">
                  {t("Latest usage reported by the active thread.")}
                </p>
                {pendingContextWindowLabel ? (
                  <p className="text-ui leading-snug text-muted-foreground">
                    {t("Current session:")} {activeContextWindowLabel ?? t("Unknown")}
                    {t(". Next turn:")} {pendingContextWindowLabel}.
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
                    <p className="text-muted-foreground">{t("Used")}</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.usedTokens)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{t("Remaining")}</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.remainingTokens)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{t("Window")}</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.maxTokens)}
                    </p>
                  </div>
                </>
              ) : (
                <div>
                  <p className="text-muted-foreground">{t("Context usage")}</p>
                  <p className="font-medium text-foreground">{t("Not reported yet")}</p>
                </div>
              )}
              <div>
                <p className="text-muted-foreground">{t("Cost")}</p>
                <p className="font-medium text-foreground">
                  {cumulativeCostUsd !== null
                    ? formatCostUsd(cumulativeCostUsd)
                    : t("Not available")}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border/60 bg-card p-4">
            <p className="text-ui leading-snug text-muted-foreground">{t("Rate Limits")}</p>
            {rateLimitStatus ? (
              <p className="text-ui leading-snug text-foreground">
                {formatRateLimitMessage(rateLimitStatus)}
              </p>
            ) : (
              <p className="text-ui leading-snug text-muted-foreground">
                {t("No active rate-limit warning for this thread.")}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
