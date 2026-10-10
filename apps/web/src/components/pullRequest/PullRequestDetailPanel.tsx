// FILE: PullRequestDetailPanel.tsx
// Purpose: Orchestrator for the pull request detail surface — owns the queries, gh-backed
//          actions (merge/ready/draft/close/reopen, fix findings, resolve conflicts, Send to
//          agent), the tab state, and the confirm dialogs. Two hosts: the chat thread's right dock
//          (a compact tab header, the default) and the code review page (`layout="page"`: the
//          GitHub item page shell shared with issues). The action controls themselves live in
//          PullRequestActions; Summary, Timeline, and Changes render in their own tab components.
// Layer: Pull request presentation
// Exports: PullRequestDetailPanel

import type {
  PullRequestAction,
  PullRequestDetailInput,
  PullRequestMergeMethod,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import {
  CHAT_HEADER_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
  ChatHeaderSplitGroup,
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
import { Menu, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { ChevronDownIcon, EllipsisIcon, ExternalLinkIcon, XIcon } from "~/lib/icons";
import {
  pullRequestActionMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestQueryErrorState,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStartGitHubItemThread } from "~/hooks/useStartGitHubItemThread";
import {
  GitHubItemAgentActions,
  TOP_BAR_NARROW_LABEL_CLASS_NAME,
  type GitHubItemSendTarget,
} from "./GitHubItemAgentActions";
import { GitHubItemHeader } from "./GitHubItemHeader";
import { PullRequestInfo } from "./GitHubItemInfo";
import {
  DETACHED_GITHUB_ITEM_PAGE_HOST,
  GitHubItemAskComposer,
  GitHubItemDetailPage,
  GitHubItemPageBody,
  GitHubItemPageIconActions,
  GitHubItemTabBody,
  GitHubItemTabs,
  PullRequestDetailSkeleton,
  type GitHubItemPageHost,
  type GitHubItemTabOption,
} from "./GitHubItemPageLayout";
import {
  githubItemCardSourceFromPullRequest,
  type GitHubItemAgentTarget,
} from "./githubItemAgentContext";
import {
  isPullRequestPrimaryActionBlocked,
  PullRequestActionMenuItems,
  PullRequestDraftStateItems,
  PullRequestPrimaryButton,
  resolvePullRequestPrimaryAction,
} from "./PullRequestActions";
import { PullRequestConfirmActionDialog } from "./PullRequestConfirmActionDialog";
import { PullRequestDiffStat } from "./PullRequestDiffStat";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import { PullRequestStateGlyph } from "./PullRequestStateGlyph";
import { PullRequestPageSummary, PullRequestSummaryTab } from "./PullRequestSummaryTab";
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

// The dock's tab row; the page names the diff "Changes" and puts it before Timeline.
const DOCK_TABS: ReadonlyArray<GitHubItemTabOption<DetailTab>> = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

// Dock header icon controls follow the chat-header recipe (chrome variant + fixed 28px square +
// full-strength glyph) so they sit level with the Merge pill and the dock chips.
const DOCK_ICON_BUTTON_CLASS_NAME = cn(
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
);

// The dock's filled pill: the shared 28px control height, and the label pinned to the ui size on
// every breakpoint (Button's xs size would drop it to 10px on desktop). `font-normal` matches the
// flat chips it sits beside.
const DOCK_PRIMARY_BUTTON_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "px-3 text-ui font-normal sm:text-ui",
);

// The page top bar's Merge / Ready for review.
const PAGE_PRIMARY_BUTTON_CLASS_NAME = "gap-1.5 px-3 font-medium";

// Lazy: the diff renderer + worker pool are heavyweight and only needed on the Code tab.
const PullRequestCodeTab = lazy(() => import("./PullRequestCodeTab"));

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
  pageHost,
}: {
  input: PullRequestDetailInput;
  initialTab?: DetailTab;
  /** "dock" (default): compact tab header for the chat dock. "page": the code review page's
   *  detail, in the GitHub item page shell. */
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
  /** Page layout: pin, side chat threads, and the floating composer, from the code review page. */
  pageHost?: GitHubItemPageHost;
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
        : {
            key: panelKey,
            tab: initialTab,
            mergeMethod: "merge",
            confirmAction: null,
            ...patch,
          },
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
  const primaryAction = detail
    ? resolvePullRequestPrimaryAction(detail, {
        mergeBlocker,
        allowedMethodCount: allowedMethods.length,
        stackCount: stackAssessment?.mergeTargetCount ?? null,
      })
    : null;
  const primaryBlocked = isPullRequestPrimaryActionBlocked(primaryAction);
  const changeDraftState = (next: "draft" | "ready") => void runAction(next);
  const primaryButton = (size: "xs" | "sm", className: string, labelClassName?: string) =>
    primaryAction ? (
      <PullRequestPrimaryButton
        action={primaryAction}
        merging={pendingAction === "merge"}
        disabled={actionPending}
        onReady={() => void runAction("ready")}
        onMerge={() => setConfirmAction("merge")}
        size={size}
        className={className}
        {...(labelClassName ? { labelClassName } : {})}
      />
    ) : null;
  const actionsMenu = detail ? (
    <PullRequestActionMenuItems
      detail={detail}
      host={layout}
      actionPending={actionPending}
      mergeMethods={allowedMethods}
      selectedMergeMethod={selectedMergeMethod}
      mergeBlocker={mergeBlocker}
      preparingThread={preparingThread}
      sendTargets={sendTargets}
      askPending={askPending === true}
      onStateChange={changeDraftState}
      onMergeMethodChange={setMergeMethod}
      onSendToAgent={sendToAgent}
      onAsk={ask}
      onFixFindings={fixFindings}
      onResolveConflicts={resolveConflicts}
      onClose={() => setConfirmAction("close")}
      onReopen={() => void runAction("reopen")}
    />
  ) : null;
  const stackPopover = detail?.stack ? (
    <PullRequestStackPopover
      stack={detail.stack}
      currentNumber={detail.number}
      {...(onSelectPullRequest ? { onSelectPullRequest } : {})}
    />
  ) : null;
  const banners = detail ? (
    <>
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
    </>
  ) : null;

  const confirmDialog = (
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
  );

  if (layout === "page") {
    const host = pageHost ?? DETACHED_GITHUB_ITEM_PAGE_HOST;
    const composer = detail ? (
      <GitHubItemAskComposer
        noun="pull request"
        defaultProjectId={detail.projectId}
        sendTargets={sendTargets}
        buildTarget={(projectId) => ({
          projectId,
          source: githubItemCardSourceFromPullRequest(detail),
        })}
        host={host}
        onSendToAgent={sendToAgent}
      />
    ) : null;
    const pageTabs: ReadonlyArray<GitHubItemTabOption<DetailTab>> = [
      { value: "summary", label: "Summary" },
      {
        value: "code",
        label: "Changes",
        trailing: detail ? (
          <PullRequestDiffStat
            additions={detail.additions}
            deletions={detail.deletions}
            tone="diff"
            // Dropped with the other top bar words once the bar is narrow.
            className="text-ui-xs @max-[46rem]/topbar:hidden"
          />
        ) : null,
      },
      { value: "timeline", label: "Timeline" },
    ];
    // Merge and its options are one split control: the label acts, the chevron opens the menu.
    // With no primary action the menu hangs off a quiet "…" instead.
    const menuTrigger = (children: ReactNode, className: string) => (
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={primaryAction ? (primaryBlocked ? "subtle" : "default") : "ghost"}
            aria-label="More actions"
            title="More actions"
            className={className}
          />
        }
      >
        {children}
      </MenuTrigger>
    );
    const actions = detail ? (
      <>
        {stackPopover}
        <GitHubItemPageIconActions
          url={detail.url}
          itemLabel={`pull request #${detail.number}`}
          pin={host.pin}
        />
        <GitHubItemAgentActions
          sendTargets={sendTargets}
          sending={preparingThread === "send"}
          onSendToAgent={sendToAgent}
        />
        <Menu>
          {primaryAction ? (
            <ChatHeaderSplitGroup label="Merge actions">
              {primaryButton(
                "sm",
                cn(CHAT_HEADER_SPLIT_LEADING_CLASS_NAME, PAGE_PRIMARY_BUTTON_CLASS_NAME),
                TOP_BAR_NARROW_LABEL_CLASS_NAME,
              )}
              {menuTrigger(
                <ChevronDownIcon aria-hidden className="size-3.5" />,
                cn(
                  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
                  // The halves share one hairline instead of a border: tinted on the filled pair,
                  // the plain border tone on the neutral pair a blocked Merge drops to.
                  "border-s px-1.5",
                  primaryBlocked ? "border-s-border" : "border-s-primary-foreground/20",
                ),
              )}
            </ChatHeaderSplitGroup>
          ) : (
            menuTrigger(<EllipsisIcon aria-hidden className="size-4" />, "px-1.5")
          )}
          <ComposerPickerMenuPopup align="end" side="bottom" className="w-56 min-w-56">
            {actionsMenu}
          </ComposerPickerMenuPopup>
        </Menu>
      </>
    ) : null;
    return (
      <GitHubItemDetailPage
        onBack={onBack}
        tabs={
          <GitHubItemTabs
            label="Pull request detail tabs"
            tabs={pageTabs}
            value={tab}
            onChange={setTab}
          />
        }
        actions={actions}
        query={{
          isPending: detailQuery.isPending,
          initialError: detailErrorState.initialError,
          onRetry: () => void detailQuery.refetch(),
          loaded: detail !== undefined,
        }}
        notFound={{
          title: "Pull request not found",
          description: "The selected pull request could not be loaded.",
        }}
        banners={banners}
        overlay={confirmDialog}
      >
        {!detail ? null : tab === "summary" ? (
          <GitHubItemPageBody
            header={
              <GitHubItemHeader
                item={{ kind: "pullRequest", ...detail }}
                {...(detail.state === "open"
                  ? {
                      stateMenu: (
                        <PullRequestDraftStateItems
                          isDraft={detail.isDraft}
                          disabled={actionPending}
                          onChange={changeDraftState}
                        />
                      ),
                    }
                  : {})}
              />
            }
            info={(variant) => (
              <PullRequestInfo
                detail={detail}
                variant={variant}
                threads={host.threads}
                onOpenThread={host.onOpenThread}
              />
            )}
            composer={composer}
          >
            <PullRequestPageSummary detail={detail} />
          </GitHubItemPageBody>
        ) : (
          <GitHubItemTabBody
            glyph={
              <PullRequestStateGlyph
                state={detail.state}
                isDraft={detail.isDraft}
                mergeability={detail.mergeability}
              />
            }
            title={detail.title}
            // The diff fills the pane edge to edge; the composer would cover it.
            composer={tab === "timeline" ? composer : null}
          >
            {tab === "timeline" ? (
              <PullRequestTimelineTab detail={detail} />
            ) : (
              <Suspense fallback={<PullRequestDetailSkeleton />}>
                <PullRequestCodeTab input={input} detail={detail} />
              </Suspense>
            )}
          </GitHubItemTabBody>
        )}
      </GitHubItemDetailPage>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col app-content-surface text-foreground">
      {/* No rule under the header: the tab row already reads as its own band, and the section
          borders further down are the only dividers the panel needs. No state glyph either:
          the dock tab above already carries it, and the Summary tab spells the state out. */}
      <header className="flex min-h-12 shrink-0 items-center gap-2 px-2">
        {/* Scrolls rather than slides under the actions when the pane is very narrow. */}
        <GitHubItemTabs
          label="Pull request detail tabs"
          tabs={DOCK_TABS}
          value={tab}
          onChange={setTab}
          className="turn-chip-strip overflow-x-auto"
        />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {detail ? (
            <>
              {stackPopover}
              <IconButton
                variant="chrome"
                label="Open in external browser"
                tooltip="Open in external browser"
                className={DOCK_ICON_BUTTON_CLASS_NAME}
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
                      className={DOCK_ICON_BUTTON_CLASS_NAME}
                    >
                      <EllipsisIcon />
                    </IconButton>
                  }
                />
                <ComposerPickerMenuPopup align="end" side="bottom" className="w-56 min-w-56">
                  {actionsMenu}
                </ComposerPickerMenuPopup>
              </Menu>
              {/* One pill, no method chevron: the method lives in the "…" menu beside the
                  other merge-adjacent actions. */}
              {primaryButton("xs", DOCK_PRIMARY_BUTTON_CLASS_NAME)}
            </>
          ) : null}
          {onClose ? (
            <IconButton
              variant="chrome"
              label="Close pull request panel"
              tooltip="Close"
              className={DOCK_ICON_BUTTON_CLASS_NAME}
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
            {banners}
            <div className="min-h-0 flex-1">
              {tab === "summary" ? (
                <PullRequestSummaryTab detail={detail} showHeading />
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

      {confirmDialog}
    </div>
  );
}

export default PullRequestDetailPanel;
