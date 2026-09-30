// FILE: PullRequestDetailPanel.tsx
// Purpose: Orchestrator for the pull request detail surface — owns the queries, gh-backed
//          actions (merge/ready/draft/close/reopen, fix findings, copy link), the header with
//          its Summary/Timeline/Code tab switcher, the Code tab's diff viewport, and the
//          confirm dialogs. Summary and Timeline rendering live in their own tab components.
//          Two hosts: the chat thread's right dock (compact tab header, the default) and the
//          GitHub inbox page (`layout="page"`: the shared GitHubItemHeader above the tabs).
//          Both offer Send to agent and Ask: as header buttons on the page, in the "…" menu in
//          the dock; each host supplies its own Ask (the inbox's side chat, or the thread's).
// Layer: Pull request presentation
// Exports: PullRequestDetailPanel, PullRequestDetailSkeleton

import type {
  PullRequestAction,
  PullRequestDetailInput,
  PullRequestMergeMethod,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";

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
  createGitHubItemContextDraft,
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
import {
  BotIcon,
  ChatBubbleIcon,
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
import {
  pullRequestActionMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestQueryErrorState,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStartGitHubItemThread } from "~/hooks/useStartGitHubItemThread";
import { GitHubItemAgentActions, type GitHubItemSendTarget } from "./GitHubItemAgentActions";
import {
  githubItemCardSourceFromPullRequest,
  type GitHubItemAgentTarget,
} from "./githubItemAgentContext";
import { GitHubItemBackButton, GitHubItemHeader } from "./GitHubItemHeader";
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
  "px-3 text-ui font-normal sm:text-ui",
);

// Lazy: the diff renderer + worker pool are heavyweight and only needed on the Code tab.
const PullRequestCodeTab = lazy(() => import("./PullRequestCodeTab"));

export function PullRequestDetailSkeleton() {
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
  layout: layoutProp,
  onClose,
  onBack,
  onSelectPullRequest,
  pollingEnabled: pollingEnabledProp,
  sendTargets: sendTargetsProp,
  onAsk,
  askPending,
}: {
  input: PullRequestDetailInput;
  initialTab?: DetailTab;
  /** "dock" (default): compact tab header for the chat dock. "page": the inbox's detail pane,
   *  led by the shared GitHubItemHeader (title, people, dates, Open on GitHub). */
  layout?: "dock" | "page";
  onClose?: () => void;
  /** Page layout on a narrow window: return to the list. */
  onBack?: () => void;
  onSelectPullRequest?: (number: number) => void;
  pollingEnabled?: boolean;
  /** Projects Send to agent may open the thread in. Defaults to the pull request's project. */
  sendTargets?: ReadonlyArray<GitHubItemSendTarget>;
  /** The host's side chat for this pull request. Absent hides Ask. */
  onAsk?: ((target: GitHubItemAgentTarget) => void) | undefined;
  askPending?: boolean;
}) {
  const initialTab = initialTabProp ?? "summary";
  const layout = layoutProp ?? "dock";
  const pollingEnabled = pollingEnabledProp ?? true;
  const queryClient = useQueryClient();
  // Panel state keyed to the PR it belongs to: switching PRs (or landing tab)
  // derives straight back to the defaults with no state-resetting effect.
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
  const actionInFlightRef = useRef(false);
  const detailQuery = useQuery(pullRequestDetailQueryOptions(input, { pollingEnabled }));
  const actionMutation = useMutation(pullRequestActionMutationOptions(queryClient));
  const detail = detailQuery.data;
  const detailErrorState = pullRequestQueryErrorState(detailQuery);
  // Fix findings, Resolve conflicts, and Send to agent all hand the pull request to a fresh
  // thread the same way: prepare its branch, open the thread, attach the card to review.
  const { start: startItemThread, pendingAction: preparingThread } = useStartGitHubItemThread({
    workspaceRoot: detail?.workspaceRoot ?? null,
  });
  const sendTargets: ReadonlyArray<GitHubItemSendTarget> =
    sendTargetsProp && sendTargetsProp.length > 0
      ? sendTargetsProp
      : detail
        ? [{ projectId: detail.projectId, projectTitle: detail.projectTitle }]
        : [];

  // Promise chain instead of async/try-finally in the runner below:
  // React Compiler does not yet support try/finally and would skip this
  // component entirely.
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

  const sendToAgent = (projectId: GitHubItemSendTarget["projectId"]) => {
    if (!detail) return;
    const source = githubItemCardSourceFromPullRequest(detail);
    startItemThread({
      action: "send",
      projectId,
      pullRequestUrl: detail.url,
      card: (environment) => createGitHubItemContextDraft(source, environment),
      errorTitle: "Could not send the pull request to an agent",
    });
  };
  const ask = onAsk
    ? () => {
        if (detail)
          onAsk({
            projectId: input.projectId,
            source: githubItemCardSourceFromPullRequest(detail),
          });
      }
    : undefined;

  const fixFindings = () => {
    if (!detail) return;
    const card = createPullRequestContextDraft({
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
    });
    startItemThread({
      action: "findings",
      projectId: detail.projectId,
      pullRequestUrl: detail.url,
      card: () => card,
      errorTitle: "Could not prepare findings",
    });
  };

  const resolveConflicts = () => {
    if (!detail) return;
    const card = createPullRequestContextDraft({
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
    });
    startItemThread({
      action: "conflicts",
      projectId: detail.projectId,
      pullRequestUrl: detail.url,
      card: () => card,
      errorTitle: "Could not prepare conflict resolution",
    });
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
  const stackAssessment = detail?.stack ? assessPullRequestStack(detail.stack) : null;
  const stackMergeTargetCount = stackAssessment?.mergeTargetCount ?? 0;
  const mergeBlocker = detail ? pullRequestMergeBlocker(detail, stackAssessment) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)] text-foreground">
      {layout === "page" && detail ? (
        <GitHubItemHeader
          item={{ kind: "pullRequest", ...detail }}
          {...(onBack ? { onBack } : {})}
          agentActions={
            <GitHubItemAgentActions
              sendTargets={sendTargets}
              sending={preparingThread === "send"}
              onSendToAgent={sendToAgent}
              onAsk={ask}
              asking={askPending === true}
            />
          }
        />
      ) : null}
      {/* No rule under the header: the tab row already reads as its own band, and the section
          borders further down are the only dividers the panel needs. */}
      <header
        className={cn(
          "flex min-h-12 shrink-0 items-center gap-2",
          layout === "page" ? "px-2.5" : "px-2",
        )}
      >
        {layout === "page" && !detail && onBack ? <GitHubItemBackButton onBack={onBack} /> : null}
        {/* No state glyph here: the dock tab above already carries it, and the Summary tab
            spells the state out in words. A third copy in between was pure repetition. */}
        {/* Scrolls rather than slides under the actions when the pane is very narrow. */}
        <nav
          className="turn-chip-strip flex min-w-0 items-center gap-0.5 overflow-x-auto"
          aria-label="Pull request detail tabs"
        >
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
              {detail.stack ? (
                <PullRequestStackPopover
                  stack={detail.stack}
                  currentNumber={detail.number}
                  {...(onSelectPullRequest ? { onSelectPullRequest } : {})}
                />
              ) : null}
              {/* The page header says "Open on GitHub" in words; the dock keeps the icon. */}
              {layout === "dock" ? (
                <IconButton
                  variant="chrome"
                  label="Open in external browser"
                  tooltip="Open in external browser"
                  className={PR_HEADER_ICON_BUTTON_CLASS_NAME}
                  onClick={() => void ensureNativeApi().shell.openExternal(detail.url)}
                >
                  <ExternalLinkIcon />
                </IconButton>
              ) : null}
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
                  {/* The page header shows these as buttons; the compact dock header keeps
                      them here, beside the other actions that hand work to a thread. */}
                  {layout === "dock" ? (
                    <>
                      {sendTargets.map((target) => (
                        <MenuItem
                          key={target.projectId}
                          onClick={() => sendToAgent(target.projectId)}
                          disabled={preparingThread !== null}
                        >
                          <BotIcon className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {preparingThread === "send"
                              ? "Preparing…"
                              : sendTargets.length > 1
                                ? `Send to agent in ${target.projectTitle}`
                                : "Send to agent"}
                          </span>
                        </MenuItem>
                      ))}
                      {ask ? (
                        <MenuItem onClick={ask} disabled={askPending === true}>
                          <ChatBubbleIcon className="size-3.5 shrink-0" />
                          <span>Ask in a side chat</span>
                        </MenuItem>
                      ) : null}
                    </>
                  ) : null}
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
              ) : detail.state === "open" && mergeBlocker !== null ? (
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
          <PullRequestDetailSkeleton />
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
                <PullRequestSummaryTab detail={detail} showHeading={layout === "dock"} />
              ) : tab === "timeline" ? (
                <PullRequestTimelineTab detail={detail} />
              ) : (
                <Suspense fallback={<PullRequestDetailSkeleton />}>
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
