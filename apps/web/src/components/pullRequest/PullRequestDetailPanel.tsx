import type {
  PullRequestAction,
  PullRequestDetailInput,
  PullRequestMergeMethod,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";

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
  createPullRequestContextDraft,
} from "~/components/chat/environment/environmentPullRequest.logic";
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
import { addChatPullRequestContext } from "~/lib/chatReferences";
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
import { type PullRequestContextDraft } from "~/lib/pullRequestContext";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  copyPullRequestLink,
  PullRequestConfirmActionDialog,
} from "./PullRequestConfirmActionDialog";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { PullRequestWarningNote } from "./PullRequestWarningNote";
import { assessPullRequestStack, pullRequestMergeBlocker } from "./pullRequestStack.logic";

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

// header icon controls follow the chat-header recipe (chrome variant + fixed 28px square) so they sit level with the Merge pill and dock chips
const PR_HEADER_ICON_BUTTON_CLASS_NAME = cn(
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
);

// filled action pill: label pinned to ui size on every breakpoint (Button's xs would drop to 10px); `font-normal` overrides Button's font-medium so it doesn't shout a weight heavier than its row
const PR_HEADER_ACTION_BUTTON_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "px-3 text-ui font-normal sm:text-ui",
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
  initialTab: initialTabProp,
  onClose,
  onSelectPullRequest,
  pollingEnabled: pollingEnabledProp,
}: {
  input: PullRequestDetailInput;
  initialTab?: DetailTab;
  onClose?: () => void;
  onSelectPullRequest?: (number: number) => void;
  pollingEnabled?: boolean;
}) {
  const initialTab = initialTabProp ?? "summary";
  const pollingEnabled = pollingEnabledProp ?? true;
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  // panel state keyed to the PR it belongs to: switching PRs derives back to defaults with no state-resetting effect
  const panelKey = `${input.projectId}\u0000${input.repository}\u0000${input.number}\u0000${initialTab}`;
  const [panelState, setPanelState] = useState<{
    key: string;
    tab: DetailTab;
    mergeMethod: PullRequestMergeMethod;
    confirmAction: "merge" | "close" | null;
  } | null>(null);
  const isCurrentPanelState = panelState !== null && panelState.key === panelKey;
  const tab = isCurrentPanelState ? panelState.tab : initialTab;
  const mergeMethod = isCurrentPanelState ? panelState.mergeMethod : "merge";
  const confirmAction = isCurrentPanelState ? panelState.confirmAction : null;
  const patchPanelState = (patch: {
    tab?: DetailTab;
    mergeMethod?: PullRequestMergeMethod;
    confirmAction?: "merge" | "close" | null;
  }) =>
    setPanelState((current) =>
      current !== null && current.key === panelKey
        ? { ...current, ...patch }
        : { key: panelKey, tab: initialTab, mergeMethod: "merge", confirmAction: null, ...patch },
    );
  const setTab = (next: DetailTab) => patchPanelState({ tab: next });
  const setMergeMethod = (next: PullRequestMergeMethod) => patchPanelState({ mergeMethod: next });
  const setConfirmAction = (next: "merge" | "close" | null) =>
    patchPanelState({ confirmAction: next });
  const [preparingThread, setPreparingThread] = useState<"findings" | "conflicts" | null>(null);
  const actionInFlightRef = useRef(false);
  const detailQuery = useQuery(pullRequestDetailQueryOptions(input, { pollingEnabled }));
  const actionMutation = useMutation(pullRequestActionMutationOptions(queryClient));
  const detail = detailQuery.data;
  const detailErrorState = pullRequestQueryErrorState(detailQuery);
  // shared git prepare mutation so Git status/snapshot caches invalidate exactly like every other prepare-thread flow
  const prepareThreadMutation = useMutation(
    gitPreparePullRequestThreadMutationOptions({
      cwd: detail?.workspaceRoot ?? null,
      queryClient,
    }),
  );

  // promise chains instead of async/try-finally: React Compiler doesn't support try/finally
  const runAction = (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    void actionMutation
      .mutateAsync({
        ...input,
        action,
        ...(method ? { mergeMethod: method } : {}),
      })
      .then((result) => {
        const title =
          action === "merge" && result.mergeOutcome === "enqueued"
            ? detail?.stack
              ? "Stack added to merge queue"
              : "Pull request added to merge queue"
            : action === "merge" && detail?.stack
              ? "Stack merged"
              : ACTION_SUCCESS_LABELS[action];
        toastManager.add({ type: "success", title });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Pull request action failed",
          description: error instanceof Error ? error.message : "GitHub CLI action failed.",
        });
      })
      .finally(() => {
        actionInFlightRef.current = false;
      });
  };

  // "Fix findings"/"Resolve conflicts" hand the PR to a fresh thread: prepare a worktree on the PR branch, create the thread, attach the task as a composer context card
  const startPullRequestThread = (
    kind: "findings" | "conflicts",
    card: PullRequestContextDraft,
    errorTitle: string,
  ) => {
    if (!detail || preparingThread !== null) return;
    setPreparingThread(kind);
    const mode = settings.defaultThreadEnvMode;
    void prepareThreadMutation
      .mutateAsync({ reference: detail.url, mode })
      .then((prepared) =>
        Promise.resolve(
          handleNewThread(detail.projectId, {
            branch: prepared.branch,
            worktreePath: prepared.worktreePath,
            envMode: mode,
            // reusing the project's existing draft can leave the user on the PR route and insert the prompt into a hidden composer — the button would appear inert
            fresh: true,
          }),
        ).then((threadId) => {
          if (!threadId) throw new Error("Could not create a draft thread for this pull request.");
          addChatPullRequestContext(threadId, card);
        }),
      )
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: errorTitle,
          description:
            error instanceof Error ? error.message : "The PR thread could not be prepared.",
        });
      })
      .finally(() => {
        setPreparingThread(null);
      });
  };

  const fixFindings = () => {
    if (!detail) return;
    void startPullRequestThread(
      "findings",
      createPullRequestContextDraft({
        scope: "everything",
        pr: detail,
        title: "Fix findings",
        subtitle: `#${detail.number} ${detail.title}`,
        text: buildFixFindingsPrompt({
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
      }),
      "Could not prepare findings",
    );
  };

  const resolveConflicts = () => {
    if (!detail) return;
    void startPullRequestThread(
      "conflicts",
      createPullRequestContextDraft({
        scope: "conflicts",
        pr: detail,
        title: "Merge conflicts",
        subtitle: `Conflicts with ${detail.baseBranch}`,
        text: buildResolveConflictsPrompt({
          prNumber: detail.number,
          prUrl: detail.url,
          baseBranch: detail.baseBranch,
          headBranch: detail.headBranch,
        }),
      }),
      "Could not prepare conflict resolution",
    );
  };

  const allowedMethods = detail
    ? (["merge", "squash", "rebase"] as const).filter((method) => detail.mergeCapabilities[method])
    : [];
  const selectedMergeMethod = allowedMethods.includes(mergeMethod)
    ? mergeMethod
    : (allowedMethods[0] ?? "merge");
  const actionPending = actionMutation.isPending;
  // optimistic transitions flip the UI instantly via the cache patch, so only the pessimistic merge needs a visible progress state
  const pendingAction = actionMutation.isPending
    ? (actionMutation.variables?.action ?? null)
    : null;
  const stackAssessment = detail?.stack ? assessPullRequestStack(detail.stack) : null;
  const stackMergeTargetCount = stackAssessment?.mergeTargetCount ?? 0;
  const mergeBlocker = detail ? pullRequestMergeBlocker(detail, stackAssessment) : null;

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
              // same chip skin as the dock tab strip and header diff toggle: one 28px rounded-lg family for every flat control in these header rows
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
              {detail.stack ? (
                <PullRequestStackPopover
                  stack={detail.stack}
                  currentNumber={detail.number}
                  {...(onSelectPullRequest ? { onSelectPullRequest } : {})}
                />
              ) : null}
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
                  mergeBlocker === null &&
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
                  <MenuItem onClick={() => copyPullRequestLink(detail.url)}>
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
                // a draft's primary action is publishing for review — merge/conflicts only matter once it leaves draft
                <Button
                  size="xs"
                  className={PR_HEADER_ACTION_BUTTON_CLASS_NAME}
                  disabled={actionPending}
                  onClick={() => void runAction("ready")}
                >
                  Ready for review
                </Button>
              ) : detail.state === "open" && mergeBlocker !== null ? (
                // header keeps saying Merge but the pill is inert until the branch reconciles; aria-disabled (not disabled) since Button's disabled sets pointer-events-none which would swallow the tooltip's hover
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
                    {detail.stack && stackAssessment ? (
                      <>
                        <span>Merge stack</span>
                        <span className="rounded-full bg-primary-foreground/16 px-1.5 text-ui-xs tabular-nums">
                          {stackAssessment.mergeTargetCount}
                        </span>
                      </>
                    ) : (
                      "Merge"
                    )}
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">{mergeBlocker}</TooltipPopup>
                </Tooltip>
              ) : detail.state === "open" && !detail.isDraft && allowedMethods.length > 0 ? (
                // one pill, no method chevron: a split button's label can never sit on the group's centre and its inner corners pin to radius 0; the method choice lives in the "…" menu
                <Button
                  size="xs"
                  className={PR_HEADER_ACTION_BUTTON_CLASS_NAME}
                  disabled={actionPending}
                  onClick={() => setConfirmAction("merge")}
                >
                  {pendingAction === "merge" ? (
                    <>
                      <LoaderIcon className="size-3.5 animate-spin" />
                      {detail.stack ? "Merging stack…" : "Merging…"}
                    </>
                  ) : detail.stack && stackAssessment ? (
                    <>
                      <span>Merge stack</span>
                      <span className="rounded-full bg-primary-foreground/16 px-1.5 text-ui-xs tabular-nums">
                        {stackAssessment.mergeTargetCount}
                      </span>
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
            {detail.stackMetadataIncomplete === true ? (
              <PullRequestWarningNote shape="banner" className="shrink-0" role="status">
                Stack details could not be loaded. Refresh before merging.
              </PullRequestWarningNote>
            ) : null}
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

      <PullRequestConfirmActionDialog
        action={
          confirmAction === "merge"
            ? { kind: "merge", method: selectedMergeMethod }
            : confirmAction === "close"
              ? { kind: "close" }
              : null
        }
        number={input.number}
        stack={detail?.stack ?? null}
        stackMergeTargetCount={stackMergeTargetCount}
        pending={actionPending}
        onDismiss={() => setConfirmAction(null)}
        onConfirm={(action) => {
          if (action.kind === "merge") void runAction("merge", action.method);
          else void runAction("close");
        }}
      />
    </div>
  );
}

export default PullRequestDetailPanel;
