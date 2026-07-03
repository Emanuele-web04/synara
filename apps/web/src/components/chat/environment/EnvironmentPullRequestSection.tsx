// FILE: EnvironmentPullRequestSection.tsx
// Purpose: "Pull request" section of the Environment panel — PR title link, live CI check
//          rollup, and open review comments with a one-click "Fix" handoff to the composer.
// Layer: Environment panel section
// Depends on: git status/PR-snapshot React Query helpers and the shared Environment row skin.

import type { GitPullRequestCheck, GitPullRequestComment, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../../ui/menu";
import { appendComposerPromptText } from "~/lib/chatReferences";
import { gitPullRequestSnapshotQueryOptions, gitStatusQueryOptions } from "~/lib/gitReactQuery";
import {
  ArrowUpRightIcon,
  ChatBubbleIcon,
  CircleAlertIcon,
  CircleCheckIcon,
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
  describePullRequestComment,
  PULL_REQUEST_CHECK_STATUS_LABELS,
  summarizePullRequestChecks,
  summarizePullRequestComments,
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

function ChecksMenuRow({
  check,
  onOpenUrl,
}: {
  check: GitPullRequestCheck;
  onOpenUrl: (url: string) => void;
}) {
  const content = (
    <>
      <CheckStatusIcon status={check.status} />
      <span className="min-w-0 truncate text-[var(--color-text-foreground)]">{check.name}</span>
      <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
        {PULL_REQUEST_CHECK_STATUS_LABELS[check.status]}
      </span>
    </>
  );

  if (!check.url) {
    return (
      <div className="grid w-full cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[0.5rem] px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)]">
        {content}
      </div>
    );
  }

  const checkUrl = check.url;
  return (
    <MenuItem
      onClick={() => onOpenUrl(checkUrl)}
      className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[0.5rem] px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)] data-highlighted:bg-[var(--color-background-elevated-secondary)]"
    >
      {content}
    </MenuItem>
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
  const content = (
    <>
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
    </>
  );

  if (!comment.url) {
    return (
      <div className="flex w-full cursor-default flex-col gap-0.5 rounded-[0.5rem] px-2 py-1.5 text-left">
        {content}
      </div>
    );
  }

  const commentUrl = comment.url;
  return (
    <MenuItem
      onClick={() => onOpenUrl(commentUrl)}
      className="flex w-full cursor-pointer flex-col gap-0.5 rounded-[0.5rem] px-2 py-1.5 text-left data-highlighted:bg-[var(--color-background-elevated-secondary)]"
    >
      {content}
    </MenuItem>
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

  if (!pr || pr.state !== "open") {
    return null;
  }

  const checks = snapshotQuery.data?.checks ?? [];
  const comments = snapshotQuery.data?.comments ?? [];
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
      buildFixReviewCommentsPrompt({ prNumber: pr.number, prUrl: pr.url, comments }),
    );
    onClose();
  };

  return (
    <EnvironmentLabeledSection label="Pull request">
      <EnvironmentRow
        icon={<GitPullRequestIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
        label={<span className="truncate">{`#${pr.number} ${pr.title}`}</span>}
        trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
        onClick={() => {
          onOpenUrl(pr.url);
          onClose();
        }}
      />

      {failed ? (
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
                        : summarizePullRequestComments(comments.length)
                  }
                  trailing={<EnvironmentRowChevron />}
                />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" side="bottom" className="w-80 min-w-80">
                {commentsError ? (
                  <MenuPlaceholder text={`Couldn't load review comments: ${commentsError}`} />
                ) : comments.length === 0 ? (
                  <MenuPlaceholder text="No unresolved review comments." />
                ) : (
                  <div className="flex flex-col gap-0.5">
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
                  </div>
                )}
              </ComposerPickerMenuPopup>
            </Menu>
            {!commentsError && comments.length > 0 && activeThreadId ? (
              <button
                type="button"
                onClick={handleFixComments}
                title="Ask the agent to address these review comments"
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
