import type {
  ReviewChangedFile,
  ReviewCheck,
  ReviewPullRequestDetail,
  ReviewSourceRef,
  ReviewTargetKey,
  ReviewTimelineEvent,
} from "@t3tools/contracts";

export interface ReviewSidechatContextPayload {
  readonly cwd: string | null;
  readonly reference: string;
  readonly url: string;
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly state: ReviewPullRequestDetail["state"];
  readonly isDraft: boolean;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headSha: string | null;
  readonly reviewDecision: string | null;
  readonly mergeable: ReviewPullRequestDetail["mergeable"];
  readonly checksStatus: ReviewPullRequestDetail["checksStatus"];
  readonly repositoryId: string | null;
  readonly source: ReviewSourceRef | null;
  readonly target: ReviewTargetKey | null;
  readonly stats: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
    readonly commits: number;
  };
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<{
    readonly login: string;
    readonly state: string;
  }>;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly state: ReviewCheck["state"];
    readonly workflow: string | null;
    readonly description: string | null;
    readonly url: string | null;
  }>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly status: string | null;
    readonly insertions: number;
    readonly deletions: number;
  }>;
  readonly recentConversation: ReadonlyArray<{
    readonly kind: "comment" | "review";
    readonly author: string;
    readonly state: string | null;
    readonly body: string;
    readonly createdAt: string;
    readonly url: string | null;
  }>;
  readonly currentView: "conversation" | "files";
  readonly selectedFilePath: string | null;
}

type ReviewSidechatRecentConversation = ReviewSidechatContextPayload["recentConversation"][number];

function reviewCheckPromptRank(state: string): number {
  if (state === "failure") return 0;
  if (state === "pending") return 1;
  return 2;
}

export interface BuildReviewSidechatContextInput {
  readonly cwd: string | null;
  readonly reference: string;
  readonly detail: ReviewPullRequestDetail;
  readonly checks: ReadonlyArray<ReviewCheck>;
  readonly events: ReadonlyArray<ReviewTimelineEvent>;
  readonly files: ReadonlyArray<ReviewChangedFile>;
  readonly source: ReviewSourceRef | null;
  readonly target: ReviewTargetKey | null;
  readonly headSha: string | null;
  readonly currentView: "conversation" | "files";
  readonly selectedFilePath: string | null;
}

export function buildReviewSidechatContextPayload(
  input: BuildReviewSidechatContextInput,
): ReviewSidechatContextPayload {
  const repositoryId = input.target?._tag === "pullRequest" ? input.target.repositoryId : null;
  return {
    cwd: input.cwd,
    reference: input.reference,
    url: input.detail.url,
    number: input.detail.number,
    title: input.detail.title,
    author: input.detail.author,
    state: input.detail.state,
    isDraft: input.detail.isDraft,
    baseBranch: input.detail.baseBranch,
    headBranch: input.detail.headBranch,
    headSha: input.headSha,
    reviewDecision: input.detail.reviewDecision,
    mergeable: input.detail.mergeable,
    checksStatus: input.detail.checksStatus,
    repositoryId,
    source: input.source,
    target: input.target,
    stats: {
      files: input.detail.changedFiles,
      additions: input.detail.additions,
      deletions: input.detail.deletions,
      commits: input.detail.commitsCount,
    },
    body: input.detail.body,
    labels: input.detail.labels.map((label) => label.name),
    reviewers: input.detail.reviewers.map((reviewer) => ({
      login: reviewer.login,
      state: reviewer.state,
    })),
    checks: input.checks.map((check) => ({
      name: check.name,
      state: check.state,
      workflow: check.workflow ?? null,
      description: check.description ?? null,
      url: check.url ?? null,
    })),
    files: input.files.map((file) => ({
      path: file.path,
      status: file.status ?? null,
      insertions: file.insertions,
      deletions: file.deletions,
    })),
    recentConversation: input.events.flatMap<ReviewSidechatRecentConversation>((event) => {
      if (event._tag === "comment") {
        return [
          {
            kind: "comment" as const,
            author: event.author,
            state: null,
            body: event.body,
            createdAt: event.createdAt,
            url: event.url ?? null,
          },
        ];
      }
      if (event._tag === "review") {
        return [
          {
            kind: "review" as const,
            author: event.author,
            state: event.state,
            body: event.body,
            createdAt: event.createdAt,
            url: event.url ?? null,
          },
        ];
      }
      return [];
    }),
    currentView: input.currentView,
    selectedFilePath: input.selectedFilePath,
  };
}

export function buildReviewSidechatInitialPrompt(
  payload: ReviewSidechatContextPayload,
  question: string,
): string {
  const selectedFile = payload.selectedFilePath;
  const files = payload.files
    .toSorted((left, right) => {
      if (selectedFile && left.path === selectedFile) return -1;
      if (selectedFile && right.path === selectedFile) return 1;
      return right.insertions + right.deletions - (left.insertions + left.deletions);
    })
    .slice(0, 12)
    .map((file) => `- ${file.path} (+${file.insertions} -${file.deletions})`)
    .join("\n");
  const checks = payload.checks
    .toSorted(
      (left, right) => reviewCheckPromptRank(left.state) - reviewCheckPromptRank(right.state),
    )
    .slice(0, 12)
    .map(
      (check) => `- ${check.name}: ${check.state}${check.workflow ? ` (${check.workflow})` : ""}`,
    )
    .join("\n");
  const conversation = payload.recentConversation
    .slice(-6)
    .map((event) => `- ${event.kind} by ${event.author}: ${event.body.slice(0, 240)}`)
    .join("\n");

  return [
    `You are helping review GitHub PR #${payload.number}: ${payload.title}.`,
    "You are running as a PR review assistant inside Synara. Do not create a new worktree, do not switch branches, and do not mutate files or repository state.",
    "Answer directly and keep the first response concise. Use the loaded PR context below plus main branch context already available to the current project. If you need more context, ask for it instead of running setup or checkout commands.",
    `Repository: ${payload.repositoryId ?? "unknown"}`,
    `URL: ${payload.url}`,
    `Author: ${payload.author}`,
    `Branch: ${payload.headBranch} -> ${payload.baseBranch}`,
    `Stats: ${payload.stats.files} files, +${payload.stats.additions} -${payload.stats.deletions}, ${payload.stats.commits} commits`,
    `Checks status: ${payload.checksStatus}`,
    payload.selectedFilePath ? `Focused file: ${payload.selectedFilePath}` : null,
    "",
    "Checks:",
    checks.length > 0 ? checks : "- No checks reported",
    "",
    "Changed files:",
    files.length > 0 ? files : "- No files loaded",
    "",
    "Recent conversation:",
    conversation.length > 0 ? conversation : "- No comments or reviews loaded",
    "",
    "Pull request description:",
    payload.body.trim().length > 0 ? payload.body.trim().slice(0, 1_500) : "(empty)",
    "",
    "User question:",
    question,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
