// FILE: PullRequestDetailPanel.tsx
// Purpose: Orchestrator for the pull request detail surface — owns the queries, gh-backed
//          actions (merge/ready/draft/close/reopen, fix findings, copy link), the header with
//          its Summary/Timeline/Code tab switcher, the Code tab's diff viewport, and the
//          confirm dialogs. Summary and Timeline rendering live in their own tab components.
// Layer: Pull request presentation
// Exports: PullRequestDetailPanel

import type {
  PullRequestAction,
  PullRequestDetailInput,
  PullRequestMergeMethod,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  CHAT_HEADER_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
  CHAT_SURFACE_CHIP_CLASS_NAME,
  CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
} from "~/components/chat/chatHeaderControls";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  buildFixFindingsPrompt,
  buildResolveConflictsPrompt,
} from "~/components/chat/environment/environmentPullRequest.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { IconButton } from "~/components/ui/icon-button";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { appendComposerPromptText } from "~/lib/chatReferences";
import {
  EllipsisIcon,
  ExternalLinkIcon,
  GitMergeConflictIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HammerIcon,
  LoaderIcon,
  LinkIcon,
  XIcon,
} from "~/lib/icons";
import { gitPreparePullRequestThreadMutationOptions } from "~/lib/gitReactQuery";
import {
  pullRequestActionMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestQueryErrorState,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { PullRequestWarningNote } from "./PullRequestWarningNote";

type DetailTab = "summary" | "timeline" | "code";

const ACTION_SUCCESS_LABELS: Record<PullRequestAction, string> = {
  merge: "Pull request merged",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: "Pull request closed",
  reopen: "Pull request reopened",
};

const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

// Header icon controls follow the chat-header recipe (chrome variant + fixed 28px square +
// full-strength glyph) so they sit level with the Merge pill and the dock chips.
const PR_HEADER_ICON_BUTTON_CLASS_NAME = cn(
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
);

// Filled header action pill (Merge / Ready for review): shared 28px control height, roomy
// padding, and the label pinned to the ui size on every breakpoint — Button's xs size would
// drop it to 10px on desktop, which reads shrunken inside a filled pill.
//
// `font-normal` overrides Button's base `font-medium`: the chips this pill sits beside are all
// font-normal, so medium made the one filled control shout a weight heavier than its whole row.
const PR_HEADER_ACTION_BUTTON_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "px-3 text-[length:var(--app-font-size-ui,12px)] font-normal sm:text-[length:var(--app-font-size-ui,12px)]",
);

// Lazy: the diff renderer + worker pool are heavyweight and only needed on the Code tab.
const PullRequestCodeTab = lazy(() => import("./PullRequestCodeTab"));

function DetailSkeleton() {
  return (
    <div className="space-y-4 p-5">
      <Skeleton className="h-7 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function PullRequestDetailPanel({
  input,
  initialTab = "summary",
  onClose,
  pollingEnabled = true,
}: {
  input: PullRequestDetailInput;
  initialTab?: DetailTab;
  onClose?: () => void;
  pollingEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("merge");
  const [confirmAction, setConfirmAction] = useState<"merge" | "close" | null>(null);
  const [preparingThread, setPreparingThread] = useState<"findings" | "conflicts" | null>(null);
  const actionInFlightRef = useRef(false);
  const detailQuery = useQuery(pullRequestDetailQueryOptions(input, { pollingEnabled }));
  const actionMutation = useMutation(pullRequestActionMutationOptions(queryClient));
  const detail = detailQuery.data;
  const detailErrorState = pullRequestQueryErrorState(detailQuery);
  // Shared git prepare mutation (instead of a raw native call) so Git status/snapshot caches
  // invalidate exactly like every other prepare-thread flow in the app.
  const prepareThreadMutation = useMutation(
    gitPreparePullRequestThreadMutationOptions({
      cwd: detail?.workspaceRoot ?? null,
      queryClient,
    }),
  );

  useEffect(() => {
    setTab(initialTab);
    setMergeMethod("merge");
    setConfirmAction(null);
  }, [initialTab, input.number, input.projectId, input.repository]);

  const runAction = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    try {
      await actionMutation.mutateAsync({
        ...input,
        action,
        ...(method ? { mergeMethod: method } : {}),
      });
      toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Pull request action failed",
        description: error instanceof Error ? error.message : "GitHub CLI action failed.",
      });
    } finally {
      actionInFlightRef.current = false;
    }
  };

  // "Fix findings" and "Resolve conflicts" hand the PR to a fresh thread the same way:
  // prepare a worktree on the PR branch, create the thread, and pre-fill the composer with
  // the task-specific prompt for the user to review and send.
  const startPullRequestThread = async (
    kind: "findings" | "conflicts",
    prompt: string,
    errorTitle: string,
  ) => {
    if (!detail || preparingThread !== null) return;
    setPreparingThread(kind);
    try {
      const mode = settings.defaultThreadEnvMode;
      const prepared = await prepareThreadMutation.mutateAsync({ reference: detail.url, mode });
      const threadId = await handleNewThread(detail.projectId, {
        branch: prepared.branch,
        worktreePath: prepared.worktreePath,
        envMode: mode,
        // This action is an explicit handoff from the PR browser. Reusing the project's
        // existing draft can leave the user on the PR route and insert the prompt into a
        // hidden composer, making the button appear inert.
        fresh: true,
      });
      if (!threadId) throw new Error("Could not create a draft thread for this pull request.");
      appendComposerPromptText(threadId, prompt);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: errorTitle,
        description:
          error instanceof Error ? error.message : "The PR thread could not be prepared.",
      });
    } finally {
      setPreparingThread(null);
    }
  };

  const fixFindings = () => {
    if (!detail) return;
    void startPullRequestThread(
      "findings",
      buildFixFindingsPrompt({
        prNumber: detail.number,
        prTitle: detail.title,
        prUrl: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        comments: detail.comments,
        checks: detail.checks,
        commentsTruncated: detail.commentsTruncated,
        commentsIncomplete: detail.commentsIncomplete,
      }),
      "Could not prepare findings",
    );
  };

  const resolveConflicts = () => {
    if (!detail) return;
    void startPullRequestThread(
      "conflicts",
      buildResolveConflictsPrompt({
        prNumber: detail.number,
        prUrl: detail.url,
        baseBranch: detail.baseBranch,
        headBranch: detail.headBranch,
      }),
      "Could not prepare conflict resolution",
    );
  };

  const copyPullRequestLink = async () => {
    if (!detail) return;
    try {
      await copyTextToClipboard(detail.url);
      toastManager.add({ type: "success", title: "Pull request link copied" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not copy pull request link",
        description: error instanceof Error ? error.message : "Clipboard access failed.",
      });
    }
  };

  const allowedMethods = detail
    ? (["merge", "squash", "rebase"] as const).filter((method) => detail.mergeCapabilities[method])
    : [];
  const selectedMergeMethod = allowedMethods.includes(mergeMethod)
    ? mergeMethod
    : (allowedMethods[0] ?? "merge");
  const actionPending = actionMutation.isPending;
  // Which action is in flight — drives the in-flight labels. Optimistic transitions
  // (draft/ready/close/reopen) flip the UI instantly via the mutation's cache patch, so
  // only the pessimistic merge needs a visible progress state.
  const pendingAction = actionMutation.isPending
    ? (actionMutation.variables?.action ?? null)
    : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)] text-foreground">
      {/* No rule under the header: the tab row already reads as its own band, and the section
          borders further down are the only dividers the panel needs. */}
      <header className="flex min-h-12 shrink-0 items-center gap-2 px-2">
        {/* No state glyph here: the dock tab above already carries it, and the Summary tab
            spells the state out in words. A third copy in between was pure repetition. */}
        <nav className="flex min-w-0 items-center gap-0.5" aria-label="Pull request detail tabs">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              onClick={() => setTab(item.value)}
              // Same chip skin as the dock tab strip ("PR #357") and the header diff toggle:
              // one 28px rounded-lg family for every flat control in these header rows.
              className={cn(
                CHAT_SURFACE_CHIP_CLASS_NAME,
                "inline-flex items-center px-2.5",
                tab === item.value && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {detail ? (
            <>
              <IconButton
                variant="chrome"
                label="Open in external browser"
                tooltip="Open in external browser"
                className={PR_HEADER_ICON_BUTTON_CLASS_NAME}
                onClick={() => void ensureNativeApi().shell.openExternal(detail.url)}
              >
                <ExternalLinkIcon />
              </IconButton>
              <Menu>
                <MenuTrigger
                  render={
                    <IconButton
                      variant="chrome"
                      label="More actions"
                      title="More actions"
                      className={PR_HEADER_ICON_BUTTON_CLASS_NAME}
                    >
                      <EllipsisIcon />
                    </IconButton>
                  }
                />
                {/* Same popup chrome as the composer pickers (model/handoff), with emoji
                    leads for scannability. */}
                <ComposerPickerMenuPopup align="end" side="bottom" className="w-56 min-w-56">
                  {detail.state === "open" ? (
                    <>
                      <MenuRadioGroup
                        value={detail.isDraft ? "draft" : "ready"}
                        onValueChange={(value) => {
                          if (actionPending) return;
                          if (value === "draft" && !detail.isDraft) void runAction("draft");
                          if (value === "ready" && detail.isDraft) void runAction("ready");
                        }}
                      >
                        <MenuRadioItem value="draft" disabled={actionPending}>
                          <GitPullRequestDraftIcon className="size-3.5 shrink-0" />
                          <span>Draft</span>
                        </MenuRadioItem>
                        <MenuRadioItem value="ready" disabled={actionPending}>
                          <GitPullRequestIcon className="size-3.5 shrink-0" />
                          <span>Ready for review</span>
                        </MenuRadioItem>
                      </MenuRadioGroup>
                      <MenuSeparator />
                    </>
                  ) : null}
                  {/* Merge method lives here rather than in a chevron welded to the Merge pill:
                      it is a preference for the action, not a second action, and the split
                      button it used to sit in made Merge a visibly different control from
                      "Ready for review". Hidden while conflicting — every method would fail. */}
                  {detail.state === "open" &&
                  !detail.isDraft &&
                  detail.mergeability !== "conflicting" &&
                  allowedMethods.length > 0 ? (
                    <>
                      <MenuRadioGroup
                        value={selectedMergeMethod}
                        onValueChange={(value) => setMergeMethod(value as PullRequestMergeMethod)}
                      >
                        {allowedMethods.map((method) => (
                          <MenuRadioItem key={method} value={method} disabled={actionPending}>
                            <GitMergeIcon className="size-3.5 shrink-0" />
                            <span className="capitalize">{method}</span>
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                      <MenuSeparator />
                    </>
                  ) : null}
                  <MenuItem onClick={() => void copyPullRequestLink()}>
                    <LinkIcon className="size-3.5 shrink-0" />
                    <span>Copy link</span>
                  </MenuItem>
                  <MenuItem onClick={fixFindings} disabled={preparingThread !== null}>
                    <HammerIcon className="size-3.5 shrink-0" />
                    <span>
                      {preparingThread === "findings" ? "Preparing findings…" : "Fix findings"}
                    </span>
                  </MenuItem>
                  {/* Sits beside Fix findings because it is the same kind of action: hand the
                      work to a new thread. Offered only when there is a conflict to resolve,
                      which is also when the header's Merge pill is disabled. */}
                  {detail.state === "open" && detail.mergeability === "conflicting" ? (
                    <MenuItem onClick={resolveConflicts} disabled={preparingThread !== null}>
                      <GitMergeConflictIcon className="size-3.5 shrink-0" />
                      <span>
                        {preparingThread === "conflicts"
                          ? "Preparing conflicts…"
                          : "Resolve conflicts"}
                      </span>
                    </MenuItem>
                  ) : null}
                  {detail.state !== "merged" ? <MenuSeparator /> : null}
                  {detail.state === "open" ? (
                    <MenuItem
                      variant="destructive"
                      disabled={actionPending}
                      onClick={() => setConfirmAction("close")}
                    >
                      <GitPullRequestClosedIcon className="size-3.5 shrink-0" />
                      <span>Close pull request</span>
                    </MenuItem>
                  ) : detail.state === "closed" ? (
                    <MenuItem disabled={actionPending} onClick={() => void runAction("reopen")}>
                      <GitPullRequestIcon className="size-3.5 shrink-0" />
                      <span>Reopen pull request</span>
                    </MenuItem>
                  ) : null}
                </ComposerPickerMenuPopup>
              </Menu>
              {detail.state === "open" && detail.isDraft ? (
                // A draft's primary action is publishing it for review — merge/conflicts
                // only become relevant once it leaves draft.
                <Button
                  size="xs"
                  className={PR_HEADER_ACTION_BUTTON_CLASS_NAME}
                  disabled={actionPending}
                  onClick={() => void runAction("ready")}
                >
                  Ready for review
                </Button>
              ) : detail.state === "open" && detail.mergeability === "conflicting" ? (
                // Non-draft only (a draft's next step is "Ready for review"). The header keeps
                // saying Merge — the action the PR is heading for — but the pill is inert until
                // the branch is reconciled, and hovering it says why. No method chevron: there
                // is nothing to choose while every method would fail. "Resolve conflicts" moved
                // into the "…" menu with the other thread-starting actions.
                //
                // aria-disabled, not disabled: Button's disabled state sets
                // `pointer-events-none`, which would swallow the hover the tooltip needs. With
                // no onClick attached there is no action to guard against.
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="xs"
                        aria-disabled="true"
                        className={cn(
                          PR_HEADER_ACTION_BUTTON_CLASS_NAME,
                          "cursor-not-allowed opacity-64",
                        )}
                      />
                    }
                  >
                    Merge
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Resolve merge conflicts before merging</TooltipPopup>
                </Tooltip>
              ) : detail.state === "open" && !detail.isDraft && allowedMethods.length > 0 ? (
                // One pill, no method chevron beside it: a split button's label can never sit
                // on the group's centre (it lands half the chevron's width to the left) and its
                // inner corners are pinned to radius 0, so Merge read as a different control
                // from the identically-purposed "Ready for review". The method choice lives in
                // the "…" menu instead, beside the other merge-adjacent actions.
                <Button
                  size="xs"
                  className={PR_HEADER_ACTION_BUTTON_CLASS_NAME}
                  disabled={actionPending}
                  onClick={() => setConfirmAction("merge")}
                >
                  {pendingAction === "merge" ? (
                    <>
                      <LoaderIcon className="size-3.5 animate-spin" />
                      Merging…
                    </>
                  ) : (
                    "Merge"
                  )}
                </Button>
              ) : null}
            </>
          ) : null}
          {onClose ? (
            <IconButton
              variant="chrome"
              label="Close pull request panel"
              tooltip="Close"
              className={PR_HEADER_ICON_BUTTON_CLASS_NAME}
              onClick={onClose}
            >
              <XIcon />
            </IconButton>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {detailQuery.isPending ? (
          <DetailSkeleton />
        ) : detailErrorState.initialError ? (
          <PullRequestsUnavailableState
            error={detailErrorState.initialError}
            onRetry={() => void detailQuery.refetch()}
          />
        ) : !detail ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Pull request not found</EmptyTitle>
              <EmptyDescription>The selected pull request could not be loaded.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {detailErrorState.backgroundError ? (
              <PullRequestWarningNote shape="banner" className="shrink-0" role="status">
                Could not refresh pull request details. Showing saved data.
              </PullRequestWarningNote>
            ) : null}
            <div className="min-h-0 flex-1">
              {tab === "summary" ? (
                <PullRequestSummaryTab detail={detail} />
              ) : tab === "timeline" ? (
                <PullRequestTimelineTab detail={detail} />
              ) : (
                <Suspense fallback={<DetailSkeleton />}>
                  <PullRequestCodeTab input={input} detail={detail} />
                </Suspense>
              )}
            </div>
          </div>
        )}
      </div>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "merge" ? "Merge pull request?" : "Close pull request?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "merge"
                ? `This will merge #${input.number} using ${selectedMergeMethod}.`
                : `This will close #${input.number} without merging it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant={confirmAction === "close" ? "destructive" : "default"}
              disabled={actionPending}
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(null);
                if (action === "merge") void runAction("merge", selectedMergeMethod);
                if (action === "close") void runAction("close");
              }}
            >
              {confirmAction === "merge" ? "Merge" : "Close"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export default PullRequestDetailPanel;
