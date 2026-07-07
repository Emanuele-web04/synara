// FILE: EnvironmentPullRequestSection.tsx
// Purpose: "Pull request" section of the Environment panel — PR title link, live CI check
//          rollup, and open review comments with a one-click "Fix" handoff to the composer.
// Layer: Environment panel section
// Depends on: git status/PR-snapshot React Query helpers and the shared Environment row skin.

import type { GitPullRequestCheck, GitPullRequestComment, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { DiffStatLabel } from "../DiffStatLabel";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { appendComposerPromptText } from "~/lib/chatReferences";
import { gitPullRequestSnapshotQueryOptions, gitStatusQueryOptions } from "~/lib/gitReactQuery";
import {
  ArrowUpRightIcon,
  BotIcon,
  ChatBubbleIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  DiffIcon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRow,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";
import {
  buildFixReviewCommentsPrompt,
  buildResolveConflictsPrompt,
  describePullRequestComment,
  PULL_REQUEST_CHECK_STATUS_LABELS,
  summarizePullRequestChecks,
  summarizePullRequestComments,
  summarizePullRequestDiffStat,
  withStableCheckKeys,
  type PullRequestChecksTone,
} from "./environmentPullRequest.logic";

function CheckStatusIcon({ status }: { status: GitPullRequestCheck["status"] }) {
  switch (status) {
    case "pending":
      return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-warning" aria-hidden />;
    case "success":
      return <CircleCheckIcon className="size-3.5 shrink-0 text-success" aria-hidden />;
    case "failure":
    case "cancelled":
      return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />;
    default:
      // Skipped/neutral render as GitHub's dashed "not run" circle.
      return (
        <span
          className="size-3 shrink-0 rounded-full border border-dashed border-current opacity-50"
          aria-hidden
        />
      );
  }
}

function checksToneIcon(tone: PullRequestChecksTone) {
  switch (tone) {
    case "failure":
      return (
        <CircleAlertIcon
          className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "text-destructive")}
          aria-hidden
        />
      );
    case "pending":
      return (
        <Loader2Icon
          className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "animate-spin text-warning")}
          aria-hidden
        />
      );
    case "success":
      return (
        <CircleCheckIcon
          className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "text-success")}
          aria-hidden
        />
      );
    default:
      return (
        <CircleCheckIcon
          className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "opacity-50")}
          aria-hidden
        />
      );
  }
}

// Popup row that is clickable only when it has a URL: plain div without one, MenuItem with one.
function MenuRow({
  url,
  onOpenUrl,
  className,
  children,
}: {
  url: string | null;
  onOpenUrl: (url: string) => void;
  className: string;
  children: ReactNode;
}) {
  if (!url) {
    return (
      <div className={cn("w-full cursor-default rounded-[0.5rem] text-left", className)}>
        {children}
      </div>
    );
  }

  return (
    <MenuItem
      onClick={() => onOpenUrl(url)}
      className={cn(
        "w-full cursor-pointer rounded-[0.5rem] text-left data-highlighted:bg-[var(--color-background-elevated-secondary)]",
        className,
      )}
    >
      {children}
    </MenuItem>
  );
}

function ChecksMenuRow({
  check,
  onOpenUrl,
}: {
  check: GitPullRequestCheck;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <MenuRow
      url={check.url}
      onOpenUrl={onOpenUrl}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1 text-[length:var(--app-font-size-ui,12px)]"
    >
      <CheckStatusIcon status={check.status} />
      <span className="min-w-0 truncate text-[var(--color-text-foreground)]">{check.name}</span>
      <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
        {PULL_REQUEST_CHECK_STATUS_LABELS[check.status]}
      </span>
    </MenuRow>
  );
}

function CommentsMenuRow({
  comment,
  onOpenUrl,
}: {
  comment: GitPullRequestComment;
  onOpenUrl: (url: string) => void;
}) {
  const display = describePullRequestComment(comment);
  return (
    // items-stretch overrides the menu-option default items-center, which would otherwise
    // center every line of this column layout (title, snippet, footer) horizontally.
    <MenuRow
      url={comment.url}
      onOpenUrl={onOpenUrl}
      className="flex flex-col items-stretch gap-0.5 px-2 py-1.5"
    >
      <span className="line-clamp-2 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]">
        {display.title}
      </span>
      {display.snippet ? (
        <span className="line-clamp-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
          {display.snippet}
        </span>
      ) : null}
      <span className="flex items-center justify-between gap-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
        <span className="min-w-0 truncate">{comment.path ?? comment.author ?? ""}</span>
        {comment.createdAt ? (
          <span className="shrink-0 tabular-nums">{formatRelativeTime(comment.createdAt)}</span>
        ) : null}
      </span>
    </MenuRow>
  );
}

function MenuPlaceholder({ text }: { text: string }) {
  return (
    <div className="px-3 py-3 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
      {text}
    </div>
  );
}

export function EnvironmentPullRequestSection({
  gitCwd,
  enabled,
  activeThreadId,
  onOpenUrl,
  onClose,
}: {
  gitCwd: string | null;
  /** Gate polling on the panel being open (mirrors the Local Servers section). */
  enabled: boolean;
  activeThreadId: ThreadId | null;
  /** Open a URL in the in-app browser panel. */
  onOpenUrl: (url: string) => void;
  onClose: () => void;
}) {
  // Shares the cached git status the git block already fetches — no extra RPC.
  const { data: gitStatus } = useQuery(gitStatusQueryOptions(gitCwd));
  const pr = gitStatus?.pr ?? null;

  const snapshotQuery = useQuery(
    gitPullRequestSnapshotQueryOptions({
      cwd: gitCwd,
      reference: pr?.url ?? null,
      enabled: enabled && pr !== null && pr.state === "open",
    }),
  );

  // The snapshot's own PR summary is fresher than the cached git status: prefer its
  // title/number/url for display, and when it reports the PR merged/closed between
  // git-status polls, swap the checks/comments rows for a state note instead of
  // rendering stale "open" data.
  const livePr = snapshotQuery.data?.pullRequest ?? null;
  const displayPr = livePr ?? pr;

  if (!pr || pr.state !== "open" || !displayPr) {
    return null;
  }

  const settledState = displayPr.state !== "open" ? displayPr.state : null;
  const diffStat = summarizePullRequestDiffStat(displayPr);
  const hasConflicts = settledState === null && displayPr.mergeability === "conflicting";

  const checks = snapshotQuery.data?.checks ?? [];
  const comments = snapshotQuery.data?.comments ?? [];
  const commentsTruncated = snapshotQuery.data?.commentsTruncated ?? false;
  const commentsError = snapshotQuery.data?.commentsError ?? null;
  const checksSummary = summarizePullRequestChecks(checks);
  const loading = snapshotQuery.isLoading;
  // Any failed refetch should be visible; otherwise stale rows look current.
  const failed = snapshotQuery.isError;

  const handleFixComments = () => {
    if (!activeThreadId || comments.length === 0) {
      return;
    }
    appendComposerPromptText(
      activeThreadId,
      buildFixReviewCommentsPrompt({
        prNumber: displayPr.number,
        prUrl: displayPr.url,
        comments,
        commentsTruncated,
      }),
    );
    onClose();
  };

  const handleResolveConflicts = () => {
    if (!activeThreadId) {
      return;
    }
    appendComposerPromptText(
      activeThreadId,
      buildResolveConflictsPrompt({
        prNumber: displayPr.number,
        prUrl: displayPr.url,
        baseBranch: displayPr.baseBranch,
        headBranch: displayPr.headBranch,
      }),
    );
    onClose();
  };

  return (
    <EnvironmentLabeledSection label="Pull request">
      <EnvironmentRow
        icon={<GitPullRequestIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
        label={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{`#${displayPr.number} ${displayPr.title}`}</span>
            {displayPr.isDraft ? (
              <span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
                Draft
              </span>
            ) : null}
          </span>
        }
        trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
        onClick={() => {
          onOpenUrl(displayPr.url);
          onClose();
        }}
      />

      {diffStat ? (
        <EnvironmentRow
          icon={<DiffIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={
            <span className="flex min-w-0 items-center gap-1.5">
              <DiffStatLabel additions={diffStat.additions} deletions={diffStat.deletions} />
              {diffStat.filesLabel ? (
                <span className="truncate text-muted-foreground">{diffStat.filesLabel}</span>
              ) : null}
            </span>
          }
          trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          title="Open the PR file changes on GitHub"
          onClick={() => {
            onOpenUrl(`${displayPr.url}/files`);
            onClose();
          }}
        />
      ) : null}

      {hasConflicts ? (
        <div className="flex w-full items-center gap-1">
          <EnvironmentRow
            className="min-w-0 flex-1"
            icon={
              <CircleAlertIcon
                className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "text-warning")}
                aria-hidden
              />
            }
            label={<span className="truncate">{`Conflicts with ${displayPr.baseBranch}`}</span>}
            trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
            onClick={() => {
              onOpenUrl(displayPr.url);
              onClose();
            }}
          />
          {activeThreadId ? (
            <button
              type="button"
              onClick={handleResolveConflicts}
              title="Drafts a prompt in the composer asking the agent to resolve the merge conflicts — review it, then send"
              className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
            >
              Fix
            </button>
          ) : null}
        </div>
      ) : null}

      {settledState ? (
        <EnvironmentRow
          icon={
            settledState === "merged" ? (
              <CircleCheckIcon
                className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "text-success")}
                aria-hidden
              />
            ) : (
              <CircleAlertIcon
                className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "opacity-60")}
                aria-hidden
              />
            )
          }
          label={settledState === "merged" ? "Merged on GitHub" : "Closed on GitHub"}
          trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          onClick={() => {
            onOpenUrl(displayPr.url);
            onClose();
          }}
        />
      ) : failed ? (
        <EnvironmentRow
          icon={
            <CircleAlertIcon
              className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "text-destructive")}
              aria-hidden
            />
          }
          label="Couldn't load PR data"
          trailing={
            <RefreshCwIcon
              className={cn("size-3 shrink-0", snapshotQuery.isFetching && "animate-spin")}
              aria-hidden
            />
          }
          title="Retry loading checks and review comments"
          onClick={() => void snapshotQuery.refetch()}
        />
      ) : (
        <>
          <Menu>
            <MenuTrigger
              render={
                <button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} disabled={loading} />
              }
            >
              <EnvironmentRowBody
                icon={
                  loading ? (
                    <RefreshCwIcon
                      className={cn(ENVIRONMENT_ROW_ICON_CLASS_NAME, "animate-spin")}
                      aria-hidden
                    />
                  ) : (
                    checksToneIcon(checksSummary.tone)
                  )
                }
                label={loading ? "Loading checks…" : checksSummary.label}
                trailing={<EnvironmentRowChevron />}
              />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="bottom" className="w-72 min-w-72">
              {checks.length === 0 ? (
                <MenuPlaceholder text="No checks reported for this PR." />
              ) : (
                <div className="flex flex-col gap-0.5">
                  {withStableCheckKeys(checks).map(({ key, check }) => (
                    <ChecksMenuRow
                      key={key}
                      check={check}
                      onOpenUrl={(url) => {
                        onOpenUrl(url);
                        onClose();
                      }}
                    />
                  ))}
                </div>
              )}
            </ComposerPickerMenuPopup>
          </Menu>

          {/*
        The whole row opens the comments popup; "Fix" is a sibling control (buttons cannot
        nest), so the row grid mirrors ENVIRONMENT_ROW_CLASS_NAME with the trigger as the
        flexible first cell.
      */}
          <div className="flex w-full items-center gap-1">
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className={cn(ENVIRONMENT_ROW_CLASS_NAME, "min-w-0 flex-1")}
                    disabled={loading}
                  />
                }
              >
                <EnvironmentRowBody
                  icon={<ChatBubbleIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
                  label={
                    loading
                      ? "Loading comments…"
                      : commentsError
                        ? "Comments unavailable"
                        : summarizePullRequestComments(comments.length, commentsTruncated)
                  }
                  trailing={<EnvironmentRowChevron />}
                />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" side="bottom" className="w-80 min-w-80">
                {commentsError ? (
                  <MenuPlaceholder text={`Couldn't load review comments: ${commentsError}`} />
                ) : comments.length === 0 ? (
                  <MenuPlaceholder
                    text={
                      commentsTruncated
                        ? "Review comments may be hidden by the bounded preview. Open the PR on GitHub."
                        : "No unresolved review comments."
                    }
                  />
                ) : (
                  <div className="flex min-h-0 flex-col gap-0.5">
                    {/* The list scrolls on its own so the "Fix with agent" footer stays visible
                        even on PRs with many comments. */}
                    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                      {comments.map((comment) => (
                        <CommentsMenuRow
                          key={comment.id}
                          comment={comment}
                          onOpenUrl={(url) => {
                            onOpenUrl(url);
                            onClose();
                          }}
                        />
                      ))}
                      {commentsTruncated ? (
                        <MenuPlaceholder text="More review comments may be available on GitHub." />
                      ) : null}
                    </div>
                    {activeThreadId ? (
                      // Self-describing twin of the sibling "Fix" button so users can see
                      // what fixing does before committing to it.
                      <>
                        <MenuSeparator />
                        <MenuItem
                          onClick={handleFixComments}
                          className="flex cursor-pointer items-start gap-2 rounded-[0.5rem] px-2 py-1.5 data-highlighted:bg-[var(--color-background-elevated-secondary)]"
                        >
                          <BotIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]">
                              Fix with agent
                            </span>
                            <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
                              Drafts a prompt with these comments in the composer — review it, then
                              send.
                            </span>
                          </span>
                        </MenuItem>
                      </>
                    ) : null}
                  </div>
                )}
              </ComposerPickerMenuPopup>
            </Menu>
            {!commentsError && comments.length > 0 && activeThreadId ? (
              <button
                type="button"
                onClick={handleFixComments}
                title="Drafts a prompt in the composer asking the agent to address these review comments — review it, then send"
                className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
              >
                Fix
              </button>
            ) : null}
          </div>
        </>
      )}
    </EnvironmentLabeledSection>
  );
}
