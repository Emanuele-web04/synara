// FILE: PullRequestDetailPanel.tsx
// Purpose: Orchestrator for the pull request detail surface — owns the queries, gh-backed
//          GitHub handoff and lifecycle actions (ready/draft/close/reopen, fix findings, copy
//          link), the header with
//          its Summary/Timeline/Code tab switcher, the Code tab's diff viewport, and the
//          confirm dialogs. Summary and Timeline rendering live in their own tab components.
// Layer: Pull request presentation
// Exports: PullRequestDetailPanel

import type { PullRequestAction, PullRequestDetailInput } from "@synara/contracts";
import { findWorkspaceForPullRequest } from "@synara/shared/pullRequest";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useRef, useState } from "react";

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
  buildReviewPullRequestPrompt,
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
import { appendComposerPromptText } from "~/lib/chatReferences";
import { readEditorRailActiveChat } from "~/editorViewState";
import {
  EllipsisIcon,
  ExternalLinkIcon,
  GitMergeConflictIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HammerIcon,
  LinkIcon,
  XIcon,
} from "~/lib/icons";
import { openPullRequestWorkspace, pullRequestWorkspaceMetadata } from "~/lib/pullRequestWorkspace";
import {
  pullRequestActionMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestQueryErrorState,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStore } from "~/store";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { PullRequestWarningNote } from "./PullRequestWarningNote";

type DetailTab = "summary" | "timeline" | "code";
const EMPTY_WORKSPACES = [] as const;

const ACTION_SUCCESS_LABELS: Record<Exclude<PullRequestAction, "merge">, string> = {
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
// full-strength glyph) so they sit level with the GitHub action and the dock chips.
const PR_HEADER_ICON_BUTTON_CLASS_NAME = cn(
  CHAT_HEADER_ICON_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
);

// Filled header action pill (workspace action / Open on GitHub): shared 28px control height, roomy
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
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const workspaces = useStore((store) => store.worktreeWorkspaces ?? EMPTY_WORKSPACES);
  const syncServerWorkspaceShellSnapshot = useStore(
    (store) => store.syncServerWorkspaceShellSnapshot,
  );
  // Key the local controls to their pull request so switching details derives the
  // defaults without a state-resetting effect.
  const panelKey = `${input.projectId}\u0000${input.repository}\u0000${input.number}\u0000${initialTab}`;
  const [panelState, setPanelState] = useState<{
    key: string;
    tab: DetailTab;
    confirmClose: boolean;
  } | null>(null);
  const isCurrentPanelState = panelState !== null && panelState.key === panelKey;
  const tab = isCurrentPanelState ? panelState.tab : initialTab;
  const confirmClose = isCurrentPanelState ? panelState.confirmClose : false;
  const patchPanelState = (patch: { tab?: DetailTab; confirmClose?: boolean }) =>
    setPanelState((current) =>
      current !== null && current.key === panelKey
        ? { ...current, ...patch }
        : { key: panelKey, tab: initialTab, confirmClose: false, ...patch },
    );
  const setTab = (next: DetailTab) => patchPanelState({ tab: next });
  const setConfirmClose = (next: boolean) => patchPanelState({ confirmClose: next });
  const [preparingThread, setPreparingThread] = useState<"findings" | "conflicts" | null>(null);
  const [workspaceAction, setWorkspaceAction] = useState<"open" | "conversation" | null>(null);
  const actionInFlightRef = useRef(false);
  const workspaceActionInFlightRef = useRef(false);
  const detailQuery = useQuery(pullRequestDetailQueryOptions(input, { pollingEnabled }));
  const actionMutation = useMutation(pullRequestActionMutationOptions(queryClient));
  const detail = detailQuery.data;
  const detailErrorState = pullRequestQueryErrorState(detailQuery);
  const project = projects.find((candidate) => candidate.id === input.projectId) ?? null;
  const associatedWorkspace = useMemo(
    () => (detail ? findWorkspaceForPullRequest(workspaces, detail.projectId, detail) : null),
    [detail, workspaces],
  );
  const associatedWorkspaceArchived =
    associatedWorkspace !== null &&
    (associatedWorkspace.state === "archived" || associatedWorkspace.archivedAt !== null);

  // Promise chains instead of async/try-finally in the two runners below:
  // React Compiler does not yet support try/finally and would skip this
  // component entirely.
  const runAction = (action: Exclude<PullRequestAction, "merge">) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    void actionMutation
      .mutateAsync({
        ...input,
        action,
      })
      .then(() => {
        toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
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

  const openWorkspace = async (input: {
    intent: "open" | "new-conversation";
    prompt?: string;
    errorTitle: string;
  }) => {
    if (!detail || workspaceActionInFlightRef.current) return;
    workspaceActionInFlightRef.current = true;
    setWorkspaceAction(input.intent === "open" ? "open" : "conversation");
    try {
      if (!project) throw new Error("The project for this pull request is no longer available.");
      const result = await openPullRequestWorkspace({
        api: ensureNativeApi(),
        project,
        defaultProvider: settings.defaultProvider,
        intent: input.intent,
        title: detail.title,
        conversationTitle: `Review PR #${detail.number}`,
        pullRequest: pullRequestWorkspaceMetadata(detail),
        preferredThreadId: associatedWorkspace
          ? readEditorRailActiveChat(`workspace:${associatedWorkspace.id}`)
          : null,
        onSnapshot: syncServerWorkspaceShellSnapshot,
      });
      if (input.prompt) appendComposerPromptText(result.threadId, input.prompt);
      await navigate({ to: "/$threadId", params: { threadId: result.threadId } });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: input.errorTitle,
        description:
          error instanceof Error ? error.message : "The pull request workspace could not open.",
      });
    } finally {
      workspaceActionInFlightRef.current = false;
      setWorkspaceAction(null);
    }
  };

  const reviewPrompt = detail
    ? buildReviewPullRequestPrompt({
        prNumber: detail.number,
        prTitle: detail.title,
        prUrl: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        comments: detail.comments,
        checks: detail.checks,
        commentsTruncated: detail.commentsTruncated,
        commentsIncomplete: detail.commentsIncomplete,
      })
    : null;

  const startPullRequestThread = async (
    kind: "findings" | "conflicts",
    prompt: string,
    errorTitle: string,
  ) => {
    if (!detail || preparingThread !== null) return;
    setPreparingThread(kind);
    try {
      await openWorkspace({
        intent: "new-conversation",
        prompt,
        errorTitle,
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

  const actionPending = actionMutation.isPending;

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
                  {associatedWorkspace ? (
                    <>
                      <MenuItem
                        disabled={workspaceAction !== null}
                        onClick={() =>
                          void openWorkspace({
                            intent: "open",
                            errorTitle: associatedWorkspaceArchived
                              ? "Could not restore workspace"
                              : "Could not open workspace",
                          })
                        }
                      >
                        <GitPullRequestIcon className="size-3.5 shrink-0" />
                        <span>
                          {associatedWorkspaceArchived ? "Restore workspace" : "Open workspace"}
                        </span>
                      </MenuItem>
                      {!associatedWorkspaceArchived ? (
                        <MenuItem
                          disabled={workspaceAction !== null}
                          onClick={() =>
                            void openWorkspace({
                              intent: "new-conversation",
                              ...(reviewPrompt ? { prompt: reviewPrompt } : {}),
                              errorTitle: "Could not create review conversation",
                            })
                          }
                        >
                          <GitPullRequestIcon className="size-3.5 shrink-0" />
                          <span>New review conversation</span>
                        </MenuItem>
                      ) : null}
                      <MenuSeparator />
                    </>
                  ) : null}
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
                      work to a new thread. Offered only when there is a conflict to resolve. */}
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
                      onClick={() => setConfirmClose(true)}
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
              {detail.state === "open" ? (
                <Button
                  size="xs"
                  className={PR_HEADER_ACTION_BUTTON_CLASS_NAME}
                  disabled={workspaceAction !== null}
                  onClick={() =>
                    void openWorkspace({
                      intent: "open",
                      ...(!associatedWorkspace && reviewPrompt ? { prompt: reviewPrompt } : {}),
                      errorTitle: associatedWorkspaceArchived
                        ? "Could not restore workspace"
                        : associatedWorkspace
                          ? "Could not open workspace"
                          : "Could not create review workspace",
                    })
                  }
                >
                  {workspaceAction === "open"
                    ? associatedWorkspaceArchived
                      ? "Restoring…"
                      : associatedWorkspace
                        ? "Opening…"
                        : "Creating…"
                    : associatedWorkspaceArchived
                      ? "Restore workspace"
                      : associatedWorkspace
                        ? "Open workspace"
                        : "Review in new workspace"}
                </Button>
              ) : (
                <Button
                  size="xs"
                  className={PR_HEADER_ACTION_BUTTON_CLASS_NAME}
                  onClick={() => void ensureNativeApi().shell.openExternal(detail.url)}
                >
                  Open on GitHub
                </Button>
              )}
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

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Close pull request?</AlertDialogTitle>
            <AlertDialogDescription>
              This will close #{input.number} without merging it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={actionPending}
              onClick={() => {
                setConfirmClose(false);
                void runAction("close");
              }}
            >
              Close
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export default PullRequestDetailPanel;
