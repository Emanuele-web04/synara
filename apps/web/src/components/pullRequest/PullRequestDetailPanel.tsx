import type {
  PullRequestAction,
  PullRequestComment,
  PullRequestDetailInput,
  PullRequestMergeMethod,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import ChatMarkdown from "~/components/ChatMarkdown";
import { DiffPanelPatchViewport } from "~/components/DiffPanelPatchViewport";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { DiffPanelLoadingState } from "~/components/DiffPanelShell";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { IconButton } from "~/components/ui/icon-button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { appendComposerPromptText } from "~/lib/chatReferences";
import { getRenderablePatch, sortFileDiffsByPath, summarizePatchTotals } from "~/lib/diffRendering";
import {
  pullRequestActionMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestDiffQueryOptions,
} from "~/lib/pullRequestReactQuery";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  ChatBubbleIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  UsersIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useTheme } from "~/hooks/useTheme";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import {
  buildFixFindingsPrompt,
  PULL_REQUEST_CHECK_STATUS_LABELS,
  PULL_REQUEST_CHECKS_TONE_TEXT_CLASS,
  summarizePullRequestChecks,
  summarizePullRequestComments,
  withStableCheckKeys,
} from "~/components/chat/environment/environmentPullRequest.logic";
import { PullRequestAvatar } from "./PullRequestAvatar";
import { PullRequestCheckStatusIcon } from "./PullRequestCheckStatusIcon";
import { parseFindingComment, type PullRequestCommentSeverity } from "./pullRequestComment.logic";
import { PullRequestDiffStat } from "./PullRequestDiffStat";
import { PullRequestStateGlyph } from "./PullRequestStateGlyph";
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

// Plain-language state descriptor shown next to the author line — the state color itself is
// already conveyed by the leading PullRequestStateGlyph in the header, so this stays neutral text.
function stateDescription(state: "open" | "closed" | "merged", isDraft: boolean): string {
  if (isDraft && state === "open") return "Draft";
  if (state === "open") return "Ready for review";
  if (state === "merged") return "Merged";
  return "Closed";
}

function severityToneClassName(severity: PullRequestCommentSeverity): string {
  if (severity === "High") return "text-destructive";
  if (severity === "Medium") return "text-warning";
  return "text-muted-foreground";
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className="flex w-20 shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  );
}

function DisclosureSection({
  label,
  count,
  children,
  defaultOpen = true,
}: {
  label: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-border/60 px-5 py-3 text-left text-xs font-medium">
        <DisclosureChevron open={open} />
        <span>{label}</span>
        {count === undefined ? null : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="px-5 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// Renders one review/issue comment as a collapsible, muted-surface card: avatar + author leading,
// timestamp + per-card collapse chevron trailing, and a "Reply" affordance that always opens the
// comment's own GitHub URL externally (falling back to the PR URL when the comment has none) —
// never the in-app browser, since replying has to happen on GitHub itself.
function CommentCard({
  comment,
  prUrl,
  workspaceRoot,
}: {
  comment: PullRequestComment;
  prUrl: string;
  workspaceRoot: string;
}) {
  const [open, setOpen] = useState(true);
  const finding = useMemo(() => parseFindingComment(comment.body), [comment.body]);
  const replyUrl = comment.url ?? prUrl;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border border-border/60 bg-[var(--color-background-elevated-secondary)]/60"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <PullRequestAvatar actor={comment.author} size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {comment.author?.login ?? "ghost"}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatRelativeTime(comment.createdAt)}
        </span>
        <DisclosureChevron open={open} />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="px-3 pb-3">
          {comment.path ? (
            <code className="mb-2 block max-w-full truncate text-[11px] text-muted-foreground">
              {comment.path}
            </code>
          ) : null}
          {finding ? (
            <div className="mb-2">
              <p className="text-sm font-semibold text-foreground">{finding.title}</p>
              <p className={cn("text-xs font-medium", severityToneClassName(finding.severity))}>
                {finding.severity} Severity
              </p>
            </div>
          ) : null}
          <ChatMarkdown
            text={(finding ? finding.body : comment.body) || "_No review body._"}
            cwd={workspaceRoot}
            isStreaming={false}
            className="text-sm"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => void ensureNativeApi().shell.openExternal(replyUrl)}
              className="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              Reply
            </button>
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

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
}: {
  input: PullRequestDetailInput;
  initialTab?: DetailTab;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();
  const { handleNewThread } = useHandleNewThread();
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("merge");
  const [confirmAction, setConfirmAction] = useState<"merge" | "close" | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const [fixing, setFixing] = useState(false);
  const actionInFlightRef = useRef(false);
  const detailQuery = useQuery(pullRequestDetailQueryOptions(input));
  const diffQuery = useQuery({
    ...pullRequestDiffQueryOptions(input),
    enabled: tab === "code",
  });
  const actionMutation = useMutation(pullRequestActionMutationOptions(queryClient));
  const detail = detailQuery.data;

  useEffect(() => {
    setTab(initialTab);
    setMergeMethod("merge");
    setConfirmAction(null);
    setCollapsedFiles(new Set());
  }, [initialTab, input.number, input.projectId, input.repository]);

  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(diffQuery.data?.patch, `pull-request:${input.projectId}:${input.number}`),
    [diffQuery.data?.patch, input.number, input.projectId],
  );
  const renderableFiles = useMemo(
    () => (renderablePatch?.kind === "files" ? sortFileDiffsByPath(renderablePatch.files) : []),
    [renderablePatch],
  );
  const patchTotals = useMemo(() => summarizePatchTotals(diffQuery.data?.patch), [diffQuery.data]);

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

  const fixFindings = async () => {
    if (!detail || fixing) return;
    setFixing(true);
    try {
      const mode = settings.defaultThreadEnvMode;
      const prepared = await ensureNativeApi().git.preparePullRequestThread({
        cwd: detail.workspaceRoot,
        reference: detail.url,
        mode,
      });
      const threadId = await handleNewThread(detail.projectId, {
        branch: prepared.branch,
        worktreePath: prepared.worktreePath,
        envMode: mode,
      });
      if (!threadId) throw new Error("Could not create a draft thread for this pull request.");
      appendComposerPromptText(
        threadId,
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
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not prepare findings",
        description:
          error instanceof Error ? error.message : "The PR thread could not be prepared.",
      });
    } finally {
      setFixing(false);
    }
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)] text-foreground">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        {detail ? (
          <PullRequestStateGlyph
            state={detail.state}
            isDraft={detail.isDraft}
            size="md"
            className="ml-1 shrink-0"
          />
        ) : null}
        <nav className="flex min-w-0 items-center gap-0.5" aria-label="Pull request detail tabs">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setTab(item.value)}
              className={cn(
                "relative h-8 rounded-md px-2.5 text-xs transition-colors",
                tab === item.value
                  ? "bg-[var(--color-background-elevated-secondary)] text-foreground"
                  : "text-muted-foreground hover:text-foreground",
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
                label="Open in external browser"
                tooltip="Open in external browser"
                onClick={() => void ensureNativeApi().shell.openExternal(detail.url)}
              >
                <ExternalLinkIcon className="size-3.5" />
              </IconButton>
              <Menu>
                <MenuTrigger
                  render={
                    <IconButton label="More actions" title="More actions">
                      <EllipsisIcon className="size-4" />
                    </IconButton>
                  }
                />
                <MenuPopup align="end" className="w-48">
                  <MenuItem onClick={() => void copyPullRequestLink()}>Copy link</MenuItem>
                  <MenuItem onClick={() => void fixFindings()} disabled={fixing}>
                    {fixing ? "Preparing findings…" : "Fix findings"}
                  </MenuItem>
                  <MenuSeparator />
                  {detail.state === "open" && detail.isDraft ? (
                    <MenuItem disabled={actionPending} onClick={() => void runAction("ready")}>
                      Ready for review
                    </MenuItem>
                  ) : null}
                  {detail.state === "open" && !detail.isDraft ? (
                    <MenuItem disabled={actionPending} onClick={() => void runAction("draft")}>
                      Convert to draft
                    </MenuItem>
                  ) : null}
                  {detail.state === "open" ? (
                    <MenuItem
                      variant="destructive"
                      disabled={actionPending}
                      onClick={() => setConfirmAction("close")}
                    >
                      Close pull request
                    </MenuItem>
                  ) : detail.state === "closed" ? (
                    <MenuItem disabled={actionPending} onClick={() => void runAction("reopen")}>
                      Reopen pull request
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
              {detail.state === "open" && !detail.isDraft && allowedMethods.length > 0 ? (
                <div className="flex items-center">
                  <Button
                    size="sm"
                    className="rounded-r-none"
                    disabled={actionPending}
                    onClick={() => setConfirmAction("merge")}
                  >
                    Merge
                  </Button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="sm"
                          className="min-w-7 rounded-l-none border-l border-primary-foreground/20 px-1"
                          aria-label="Choose merge method"
                          disabled={actionPending}
                        />
                      }
                    >
                      <DisclosureChevron open={false} className="rotate-90 text-current" />
                    </MenuTrigger>
                    <MenuPopup align="end" className="w-44">
                      <MenuRadioGroup
                        value={selectedMergeMethod}
                        onValueChange={(value) => setMergeMethod(value as PullRequestMergeMethod)}
                      >
                        {allowedMethods.map((method) => (
                          <MenuRadioItem key={method} value={method}>
                            <span className="capitalize">{method}</span>
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuPopup>
                  </Menu>
                </div>
              ) : null}
            </>
          ) : null}
          {onClose ? (
            <IconButton label="Close pull request panel" tooltip="Close" onClick={onClose}>
              <XIcon className="size-4" />
            </IconButton>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {detailQuery.isPending ? (
          <DetailSkeleton />
        ) : detailQuery.isError ? (
          <PullRequestsUnavailableState
            error={detailQuery.error}
            onRetry={() => void detailQuery.refetch()}
          />
        ) : !detail ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Pull request not found</EmptyTitle>
              <EmptyDescription>The selected pull request could not be loaded.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : tab === "summary" ? (
          <div className="h-full overflow-y-auto">
            <section className="space-y-3 px-5 py-5">
              <div className="flex items-start gap-3">
                <PullRequestAvatar actor={detail.author} size="lg" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <h1 className="text-lg font-semibold leading-snug">{detail.title}</h1>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{detail.author?.login ?? "ghost"}</span>
                    <span>·</span>
                    <span>{formatRelativeTime(detail.updatedAt)}</span>
                    <span>·</span>
                    <span>{stateDescription(detail.state, detail.isDraft)}</span>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-card/35 px-3">
                <MetaRow icon={<GitBranchIcon className="size-3.5" />} label="Branch">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <code
                      className="max-w-[9rem] truncate rounded bg-muted px-1.5 py-0.5 text-[11px]"
                      title={detail.headBranch}
                    >
                      {detail.headBranch}
                    </code>
                    <span className="text-muted-foreground">›</span>
                    <code
                      className="max-w-[9rem] truncate rounded bg-muted px-1.5 py-0.5 text-[11px]"
                      title={detail.baseBranch}
                    >
                      {detail.baseBranch}
                    </code>
                    <PullRequestDiffStat
                      additions={detail.additions}
                      deletions={detail.deletions}
                      className="ml-1"
                    />
                  </span>
                </MetaRow>
                <MetaRow icon={<UsersIcon className="size-3.5" />} label="Reviewers">
                  {detail.reviewers.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1.5">
                      {detail.reviewers.map((actor) => (
                        <span
                          key={actor.login}
                          title={actor.login}
                          className="flex items-center gap-1 rounded-full bg-muted/60 py-0.5 pr-2 pl-0.5"
                        >
                          <PullRequestAvatar actor={actor} size="sm" />
                          <span className="max-w-[8rem] truncate text-[11px]">{actor.login}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </MetaRow>
                <MetaRow icon={<ChatBubbleIcon className="size-3.5" />} label="Comments">
                  {summarizePullRequestComments(detail.comments.length)}
                </MetaRow>
                <MetaRow icon={<CircleCheckIcon className="size-3.5" />} label="Checks">
                  {(() => {
                    const summary = summarizePullRequestChecks(detail.checks);
                    return (
                      <span className={PULL_REQUEST_CHECKS_TONE_TEXT_CLASS[summary.tone]}>
                        {summary.label}
                      </span>
                    );
                  })()}
                </MetaRow>
              </div>
            </section>
            {/* No edit pencil here: there is no backend "edit PR description" action to back it. */}
            <DisclosureSection label="Description">
              <ChatMarkdown
                text={detail.body || "_No description provided._"}
                cwd={detail.workspaceRoot}
                isStreaming={false}
                className="text-sm"
              />
            </DisclosureSection>
            <DisclosureSection label="Checks" count={detail.checks.length}>
              <div className="space-y-1">
                {detail.checks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No checks reported.</p>
                ) : (
                  withStableCheckKeys(detail.checks).map(({ key, check }) => (
                    <button
                      key={key}
                      type="button"
                      disabled={!check.url}
                      onClick={() =>
                        check.url && void ensureNativeApi().shell.openExternal(check.url)
                      }
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50 disabled:hover:bg-transparent"
                    >
                      <PullRequestCheckStatusIcon status={check.status} />
                      <span className="min-w-0 flex-1 truncate">{check.name}</span>
                      <span className="text-muted-foreground">
                        {PULL_REQUEST_CHECK_STATUS_LABELS[check.status]}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </DisclosureSection>
            <DisclosureSection label="Comments" count={detail.comments.length} defaultOpen={false}>
              <div className="space-y-2">
                {detail.commentsTruncated || detail.commentsIncomplete ? (
                  <PullRequestWarningNote>
                    {detail.commentsIncomplete
                      ? "Some unresolved review comments could not be loaded. Check GitHub for the complete review."
                      : "More unresolved review comments may be available on GitHub."}
                  </PullRequestWarningNote>
                ) : null}
                {detail.comments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No comments yet.</p>
                ) : (
                  detail.comments.map((comment) => (
                    <CommentCard
                      key={comment.id}
                      comment={comment}
                      prUrl={detail.url}
                      workspaceRoot={detail.workspaceRoot}
                    />
                  ))
                )}
              </div>
            </DisclosureSection>
          </div>
        ) : tab === "timeline" ? (
          <div className="h-full overflow-y-auto px-5 py-5">
            <div className="relative ml-2 border-l border-border/70 pl-5">
              {[
                {
                  id: "created",
                  at: detail.createdAt,
                  title: `${detail.author?.login ?? "Someone"} opened this pull request`,
                  body: null,
                },
                ...detail.commits.map((commit) => ({
                  id: commit.oid,
                  at: commit.committedDate,
                  title: `Commit ${commit.oid.slice(0, 7)}`,
                  body: commit.messageHeadline || "No commit message.",
                })),
                ...detail.comments.map((comment) => ({
                  id: comment.id,
                  at: comment.createdAt,
                  title: `${comment.author?.login ?? "Someone"} ${comment.kind === "review" ? "reviewed" : "commented"}`,
                  body: comment.body,
                })),
                ...(detail.mergedAt
                  ? [
                      {
                        id: "merged",
                        at: detail.mergedAt,
                        title: "Pull request merged",
                        body: null,
                      },
                    ]
                  : []),
                ...(detail.closedAt && !detail.mergedAt
                  ? [
                      {
                        id: "closed",
                        at: detail.closedAt,
                        title: "Pull request closed",
                        body: null,
                      },
                    ]
                  : []),
              ]
                .toSorted((left, right) => left.at.localeCompare(right.at))
                .map((event) => (
                  <article key={event.id} className="relative pb-5 text-sm">
                    <span className="absolute -left-[1.55rem] top-1 size-2 rounded-full border border-border bg-background" />
                    <div className="font-medium">{event.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatRelativeTime(event.at)}
                    </div>
                    {event.body ? (
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                        {event.body}
                      </p>
                    ) : null}
                  </article>
                ))}
            </div>
          </div>
        ) : (
          <DiffWorkerPoolProvider>
            <div className="flex h-full min-h-0 flex-col">
              {diffQuery.data?.truncated ? (
                <div className="border-b border-warning/32 bg-warning/4 px-3 py-2 text-xs text-warning-foreground">
                  Diff exceeded 8 MiB and was truncated.
                </div>
              ) : null}
              {patchTotals ? (
                <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  <span>{patchTotals.fileCount} files ·</span>
                  <PullRequestDiffStat
                    additions={patchTotals.additions}
                    deletions={patchTotals.deletions}
                  />
                </div>
              ) : null}
              {diffQuery.isPending ? (
                <DiffPanelLoadingState label="Loading pull request diff…" />
              ) : (
                <DiffPanelPatchViewport
                  renderablePatch={renderablePatch}
                  renderableFiles={renderableFiles}
                  resolvedTheme={resolvedTheme}
                  diffRenderMode="split"
                  diffWordWrap
                  workspaceRoot={detail.workspaceRoot}
                  collapsedFiles={collapsedFiles}
                  onToggleFileCollapsed={(key) =>
                    setCollapsedFiles((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  isLoading={diffQuery.isFetching}
                  hasNoChanges={diffQuery.isSuccess && !renderablePatch}
                  error={
                    diffQuery.isError
                      ? diffQuery.error instanceof Error
                        ? diffQuery.error.message
                        : "Could not load diff."
                      : null
                  }
                  loadingLabel="Loading pull request diff…"
                  emptyLabel="This pull request has no file changes."
                  unavailableLabel="The pull request diff is unavailable."
                  viewKind="repo"
                />
              )}
            </div>
          </DiffWorkerPoolProvider>
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
