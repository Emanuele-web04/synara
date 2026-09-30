// FILE: GitHubIssueDetailPanel.tsx
// Purpose: The inbox detail pane for an issue: the shared GitHubItemHeader, then the body and the
//          comments (with the comment composer) in the same disclosure sections, markdown
//          renderer, and comment rows the pull request Summary tab uses. The header offers Send to
//          agent (a new draft thread with the issue attached) and the host's Ask.
// Layer: GitHub inbox presentation
// Exports: GitHubIssueDetailPanel

import type { GitHubIssueDetailInput } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createGitHubItemContextDraft } from "~/components/chat/environment/environmentPullRequest.logic";
import {
  GitHubItemAgentActions,
  type GitHubItemSendTarget,
} from "~/components/pullRequest/GitHubItemAgentActions";
import {
  githubItemCardSourceFromIssue,
  type GitHubItemAgentTarget,
} from "~/components/pullRequest/githubItemAgentContext";
import { GitHubItemBackButton, GitHubItemHeader } from "~/components/pullRequest/GitHubItemHeader";
import { PullRequestCommentCard } from "~/components/pullRequest/PullRequestCommentCard";
import { PullRequestCommentComposer } from "~/components/pullRequest/PullRequestCommentComposer";
import { PullRequestDetailSkeleton } from "~/components/pullRequest/PullRequestDetailPanel";
import { PullRequestDisclosureSection } from "~/components/pullRequest/PullRequestDisclosureSection";
import { PullRequestMarkdown } from "~/components/pullRequest/PullRequestMarkdown";
import { PullRequestsUnavailableState } from "~/components/pullRequest/PullRequestsUnavailableState";
import { PR_BODY_TEXT_CLASS_NAME } from "~/components/pullRequest/pullRequestText";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { useStartGitHubItemThread } from "~/hooks/useStartGitHubItemThread";
import {
  githubIssueCommentMutationOptions,
  githubIssueDetailQueryOptions,
} from "~/lib/githubInboxQueryOptions";
import { pullRequestQueryErrorState } from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";

export function GitHubIssueDetailPanel({
  input,
  onBack,
  pollingEnabled: pollingEnabledProp,
  sendTargets: sendTargetsProp,
  onAsk,
  askPending,
}: {
  input: GitHubIssueDetailInput;
  /** Narrow windows show the detail in place of the list; this returns to it. */
  onBack?: () => void;
  pollingEnabled?: boolean;
  /** Projects Send to agent may open the thread in. Defaults to the issue's project. */
  sendTargets?: ReadonlyArray<GitHubItemSendTarget>;
  /** The host's side chat for this issue. Absent hides Ask. */
  onAsk?: ((target: GitHubItemAgentTarget) => void) | undefined;
  askPending?: boolean;
}) {
  const pollingEnabled = pollingEnabledProp ?? true;
  const queryClient = useQueryClient();
  const detailQuery = useQuery(githubIssueDetailQueryOptions(input, { pollingEnabled }));
  const commentMutation = useMutation(githubIssueCommentMutationOptions(queryClient));
  const detail = detailQuery.data;
  const { initialError, backgroundError } = pullRequestQueryErrorState(detailQuery);
  const { start: startItemThread, pendingAction } = useStartGitHubItemThread({
    workspaceRoot: detail?.workspaceRoot ?? null,
  });
  const sendTargets: ReadonlyArray<GitHubItemSendTarget> =
    sendTargetsProp && sendTargetsProp.length > 0
      ? sendTargetsProp
      : detail
        ? [{ projectId: detail.projectId, projectTitle: detail.projectTitle }]
        : [];
  const sendToAgent = (projectId: GitHubItemSendTarget["projectId"]) => {
    if (!detail) return;
    const source = githubItemCardSourceFromIssue(detail);
    startItemThread({
      action: "send",
      projectId,
      card: (environment) => createGitHubItemContextDraft(source, environment),
      errorTitle: "Could not send the issue to an agent",
    });
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)] text-foreground">
      {detail ? (
        <GitHubItemHeader
          item={{ kind: "issue", ...detail }}
          {...(onBack ? { onBack } : {})}
          agentActions={
            <GitHubItemAgentActions
              sendTargets={sendTargets}
              sending={pendingAction === "send"}
              onSendToAgent={sendToAgent}
              onAsk={
                onAsk
                  ? () =>
                      onAsk({
                        projectId: input.projectId,
                        source: githubItemCardSourceFromIssue(detail),
                      })
                  : undefined
              }
              asking={askPending === true}
            />
          }
        />
      ) : onBack ? (
        <div className="shrink-0 px-2.5 pt-2.5">
          <GitHubItemBackButton onBack={onBack} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {detailQuery.isPending ? (
          <PullRequestDetailSkeleton />
        ) : initialError ? (
          <PullRequestsUnavailableState
            error={initialError}
            subject="Issues"
            onRetry={() => void detailQuery.refetch()}
          />
        ) : !detail ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Issue not found</EmptyTitle>
              <EmptyDescription>The selected issue could not be loaded.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {backgroundError ? (
              <PullRequestWarningNote shape="banner" role="status">
                Could not refresh the issue. Showing saved data.
              </PullRequestWarningNote>
            ) : null}
            <PullRequestDisclosureSection label="Description">
              <PullRequestMarkdown
                text={detail.body}
                fallback="_No description provided._"
                cwd={detail.workspaceRoot}
              />
            </PullRequestDisclosureSection>
            <PullRequestDisclosureSection label="Comments" count={detail.commentCount}>
              <div className="space-y-2">
                {detail.commentsTruncated ? (
                  <PullRequestWarningNote>
                    Some comments are not shown here. Open the issue on GitHub for the full
                    discussion.
                  </PullRequestWarningNote>
                ) : null}
                {detail.comments.length === 0 ? (
                  <p
                    className={cn(
                      PR_BODY_TEXT_CLASS_NAME,
                      "py-4 text-center text-muted-foreground",
                    )}
                  >
                    No comments
                  </p>
                ) : (
                  <div>
                    {detail.comments.map((comment, index) => (
                      <PullRequestCommentCard
                        key={comment.id}
                        comment={comment}
                        prUrl={detail.url}
                        workspaceRoot={detail.workspaceRoot}
                        defaultOpen={index >= detail.comments.length - 2}
                      />
                    ))}
                  </div>
                )}
                <PullRequestCommentComposer target={detail} mutation={commentMutation} />
              </div>
            </PullRequestDisclosureSection>
          </>
        )}
      </div>
    </div>
  );
}
