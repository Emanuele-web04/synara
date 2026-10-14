// FILE: GitHubIssueDetailPanel.tsx
// Purpose: The inbox detail pane for an issue, in the same page shell as a pull request: a top
//          bar (Summary and Timeline tabs; pin, copy link, open on GitHub, Send to agent), the
//          shared GitHubItemHeader, the description and comments (with the comment composer) on
//          the left, and Assignees, Labels, and Comments in the info column (rows under the
//          header in a narrow pane). The question composer floats over the bottom and feeds the
//          issue's side chat. There is no close/reopen action: the app has no RPC for changing
//          an issue's state.
// Layer: GitHub inbox presentation
// Exports: GitHubIssueDetailPanel

import type { GitHubIssueDetailInput } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { createGitHubItemContextDraft } from "~/components/chat/environment/environmentPullRequest.logic";
import {
  GitHubItemAgentActions,
  type GitHubItemSendTarget,
} from "~/components/pullRequest/GitHubItemAgentActions";
import { GitHubItemHeader } from "~/components/pullRequest/GitHubItemHeader";
import { IssueInfo } from "~/components/pullRequest/GitHubItemInfo";
import {
  DETACHED_GITHUB_ITEM_PAGE_HOST,
  GitHubItemAskComposer,
  GitHubItemDetailPage,
  GitHubItemPageBody,
  GitHubItemPageIconActions,
  GitHubItemTabBody,
  GitHubItemTabs,
  type GitHubItemPageHost,
} from "~/components/pullRequest/GitHubItemPageLayout";
import {
  githubItemCardSourceFromIssue,
  type GitHubItemAgentTarget,
} from "~/components/pullRequest/githubItemAgentContext";
import { IssueStateGlyph } from "~/components/pullRequest/PullRequestStateGlyph";
import {
  GitHubItemComments,
  GitHubItemPageSummary,
} from "~/components/pullRequest/PullRequestSummaryTab";
import { PullRequestTimelineTab } from "~/components/pullRequest/PullRequestTimelineTab";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import { useStartGitHubItemThread } from "~/hooks/useStartGitHubItemThread";
import {
  githubIssueCommentMutationOptions,
  githubIssueDetailQueryOptions,
} from "~/lib/githubInboxQueryOptions";
import { pullRequestQueryErrorState } from "~/lib/pullRequestReactQuery";

type IssueTab = "summary" | "timeline";

const ISSUE_TABS: ReadonlyArray<{ value: IssueTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
];

export function GitHubIssueDetailPanel({
  input,
  onBack,
  pollingEnabled: pollingEnabledProp,
  sendTargets: sendTargetsProp,
  pageHost,
}: {
  input: GitHubIssueDetailInput;
  /** Narrow windows show the detail in place of the list; this returns to it. */
  onBack?: () => void;
  pollingEnabled?: boolean;
  /** Projects Send to agent may open the thread in. Defaults to the issue's project. */
  sendTargets?: ReadonlyArray<GitHubItemSendTarget>;
  /** Pin, side chat threads, and the floating composer, from the code review page. */
  pageHost?: GitHubItemPageHost;
}) {
  const pollingEnabled = pollingEnabledProp ?? true;
  // The page remounts the panel per issue, so the tab starts on Summary for each one.
  const [tab, setTab] = useState<IssueTab>("summary");
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

  const host = pageHost ?? DETACHED_GITHUB_ITEM_PAGE_HOST;
  const target = (projectId: GitHubItemSendTarget["projectId"]): GitHubItemAgentTarget => ({
    projectId,
    source: githubItemCardSourceFromIssue(detail!),
  });
  const composer = detail ? (
    <GitHubItemAskComposer
      noun="issue"
      defaultProjectId={detail.projectId}
      sendTargets={sendTargets}
      buildTarget={target}
      host={host}
      onSendToAgent={sendToAgent}
    />
  ) : null;

  return (
    <GitHubItemDetailPage
      onBack={onBack}
      tabs={
        <GitHubItemTabs label="Issue detail tabs" tabs={ISSUE_TABS} value={tab} onChange={setTab} />
      }
      actions={
        detail ? (
          <>
            <GitHubItemPageIconActions
              url={detail.url}
              itemLabel={`issue #${detail.number}`}
              pin={host.pin}
            />
            <GitHubItemAgentActions
              sendTargets={sendTargets}
              sending={pendingAction === "send"}
              onSendToAgent={sendToAgent}
            />
          </>
        ) : null
      }
      query={{
        isPending: detailQuery.isPending,
        initialError,
        subject: "Issues",
        onRetry: () => void detailQuery.refetch(),
        loaded: detail !== undefined,
      }}
      notFound={{
        title: "Issue not found",
        description: "The selected issue could not be loaded.",
      }}
      banners={
        backgroundError ? (
          <PullRequestWarningNote shape="banner" role="status">
            Could not refresh the issue. Showing saved data.
          </PullRequestWarningNote>
        ) : null
      }
    >
      {!detail ? null : tab === "summary" ? (
        <GitHubItemPageBody
          header={<GitHubItemHeader item={{ kind: "issue", ...detail }} />}
          info={(variant) => (
            <IssueInfo
              detail={detail}
              variant={variant}
              threads={host.threads}
              onOpenThread={host.onOpenThread}
            />
          )}
          composer={composer}
        >
          <GitHubItemPageSummary
            body={detail.body}
            workspaceRoot={detail.workspaceRoot}
            commentCount={detail.commentCount}
          >
            <GitHubItemComments
              comments={detail.comments}
              itemUrl={detail.url}
              workspaceRoot={detail.workspaceRoot}
              warning={
                detail.commentsTruncated
                  ? "Some comments are not shown here. Open the issue on GitHub for the full discussion."
                  : null
              }
              target={detail}
              mutation={commentMutation}
            />
          </GitHubItemPageSummary>
        </GitHubItemPageBody>
      ) : (
        <GitHubItemTabBody
          glyph={<IssueStateGlyph state={detail.state} stateReason={detail.stateReason} />}
          title={detail.title}
          composer={composer}
        >
          <PullRequestTimelineTab detail={detail} noun="issue" />
        </GitHubItemTabBody>
      )}
    </GitHubItemDetailPage>
  );
}
