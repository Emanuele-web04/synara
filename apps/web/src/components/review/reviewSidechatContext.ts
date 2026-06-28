import type {
  ReviewChangedFile,
  ReviewCheck,
  ReviewPullRequestDetail,
  ReviewPullRequestHeaderDetail,
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
  readonly checksStatus: ReviewPullRequestDetail["checksStatus"] | "unknown";
  readonly repositoryId: string | null;
  readonly source: ReviewSourceRef | null;
  readonly target: ReviewTargetKey | null;
  readonly stats: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
    readonly commits: number | null;
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

type ReviewSidechatAgentContextFields = Pick<
  ReviewSidechatContextPayload,
  "cwd" | "repositoryId" | "target" | "headSha" | "files" | "stats"
>;

export function hasReviewSidechatAgentContext(payload: ReviewSidechatAgentContextFields): boolean {
  return (
    payload.cwd !== null &&
    payload.repositoryId !== null &&
    payload.target !== null &&
    payload.headSha !== null &&
    (payload.files.length > 0 || payload.stats.files === 0)
  );
}

type ReviewSidechatRecentConversation = ReviewSidechatContextPayload["recentConversation"][number];
type ReviewSidechatPromptIntent =
  | "summary"
  | "checks"
  | "review-order"
  | "conversation"
  | "focused";

function reviewCheckPromptRank(state: string): number {
  if (state === "failure") return 0;
  if (state === "pending") return 1;
  return 2;
}

function reviewSidechatPromptIntent(question: string): ReviewSidechatPromptIntent {
  const normalized = question.toLowerCase();
  if (
    normalized.includes("failing check") ||
    normalized.includes("failed check") ||
    normalized.includes("explain the checks") ||
    normalized.includes("explain failing") ||
    normalized.includes("ci")
  ) {
    return "checks";
  }
  if (
    normalized.includes("review first") ||
    normalized.includes("look at first") ||
    normalized.includes("start reviewing") ||
    normalized.includes("start with") ||
    normalized.includes("review order")
  ) {
    return "review-order";
  }
  if (
    normalized.includes("comment") ||
    normalized.includes("conversation") ||
    normalized.includes("reviewer") ||
    normalized.includes("requested changes")
  ) {
    return "conversation";
  }
  if (
    normalized.includes("summarize") ||
    normalized.includes("summary") ||
    normalized.includes("what changed") ||
    normalized.includes("changed?")
  ) {
    return "summary";
  }
  return "focused";
}

function sortedReviewFiles(
  payload: ReviewSidechatContextPayload,
): ReviewSidechatContextPayload["files"] {
  const selectedFile = payload.selectedFilePath;
  return payload.files.toSorted((left, right) => {
    if (selectedFile && left.path === selectedFile) return -1;
    if (selectedFile && right.path === selectedFile) return 1;
    return right.insertions + right.deletions - (left.insertions + left.deletions);
  });
}

function formatReviewFiles(payload: ReviewSidechatContextPayload, limit: number): string {
  return sortedReviewFiles(payload)
    .slice(0, limit)
    .map((file) => `- ${file.path} (+${file.insertions} -${file.deletions})`)
    .join("\n");
}

function reviewFilesFallback(payload: ReviewSidechatContextPayload): string {
  if (payload.stats.files > 0) {
    return `- Changed-file list not in this packet (${String(payload.stats.files)} files reported). Run \`gh pr diff ${String(payload.number)} --name-only\` to list them, or \`gh pr diff ${String(payload.number)}\` for the full diff.`;
  }
  return "- No changed files reported";
}

function formatReviewChecks(input: {
  readonly payload: ReviewSidechatContextPayload;
  readonly limit: number;
  readonly includeOnlyAttentionChecks: boolean;
  readonly includeDetail: boolean;
}): string {
  const checks = input.payload.checks
    .filter((check) => !input.includeOnlyAttentionChecks || check.state !== "success")
    .toSorted(
      (left, right) => reviewCheckPromptRank(left.state) - reviewCheckPromptRank(right.state),
    )
    .slice(0, input.limit)
    .map((check) => {
      const workflow = check.workflow ? ` (${check.workflow})` : "";
      const detail = input.includeDetail
        ? [check.description, check.url].filter((value) => value && value.length > 0).join(" ")
        : "";
      return `- ${check.name}: ${check.state}${workflow}${detail ? ` - ${detail}` : ""}`;
    });
  return checks.join("\n");
}

function formatRecentConversation(payload: ReviewSidechatContextPayload, limit: number): string {
  return payload.recentConversation
    .slice(-limit)
    .map((event) => `- ${event.kind} by ${event.author}: ${event.body.slice(0, 160)}`)
    .join("\n");
}

function promptBaseLines(payload: ReviewSidechatContextPayload): string[] {
  return [
    `PR #${payload.number}: ${payload.title}`,
    "Role: PR review assistant in Synara, running in the repository working directory with read-only git and gh access. Do not create a worktree, switch branches, or mutate files.",
    `Inspect the real changes before answering file- or diff-level questions: run \`gh pr diff ${String(payload.number)}\` for the full diff, or \`gh pr view ${String(payload.number)} --json files,title,body,additions,deletions,commits\` for metadata and the changed-file list. The packet below is a summary, not the full change -- read the diff instead of guessing at structure.`,
    `Repository: ${payload.repositoryId ?? "unknown"}`,
    `URL: ${payload.url}`,
    `Branch: ${payload.headBranch} -> ${payload.baseBranch}`,
    `Stats: ${payload.stats.files} files, +${payload.stats.additions} -${payload.stats.deletions}, ${
      payload.stats.commits === null ? "unknown" : String(payload.stats.commits)
    } commits`,
    `Checks status: ${payload.checksStatus}`,
    payload.selectedFilePath ? `Focused file: ${payload.selectedFilePath}` : null,
  ].filter((line): line is string => line !== null);
}

function compactReviewBody(payload: ReviewSidechatContextPayload, limit: number): string {
  const body = payload.body.trim();
  return body.length > 0 ? body.slice(0, limit) : "(empty)";
}

export interface BuildReviewSidechatContextInput {
  readonly cwd: string | null;
  readonly reference: string;
  readonly detail: ReviewPullRequestDetail | ReviewPullRequestHeaderDetail;
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
    checksStatus: input.detail.checksStatus ?? "unknown",
    repositoryId,
    source: input.source,
    target: input.target,
    stats: {
      files: input.detail.changedFiles,
      additions: input.detail.additions,
      deletions: input.detail.deletions,
      commits: input.detail.commitsCount ?? null,
    },
    body: input.detail.body,
    labels: input.detail.labels.map((label) => label.name),
    reviewers: (input.detail.reviewers ?? []).map((reviewer) => ({
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

export function buildReviewSidechatContextPrompt(
  payload: ReviewSidechatContextPayload,
  question: string,
): string {
  const intent = reviewSidechatPromptIntent(question);
  const base = promptBaseLines(payload);
  const checks = formatReviewChecks({
    payload,
    limit: intent === "checks" ? 10 : 5,
    includeOnlyAttentionChecks: intent === "checks",
    includeDetail: intent === "checks",
  });
  const files = formatReviewFiles(payload, intent === "review-order" ? 10 : 6);
  const conversation = formatRecentConversation(payload, intent === "conversation" ? 4 : 2);

  const sections: string[] = [...base];
  if (intent === "checks") {
    sections.push(
      "",
      "Checks needing attention:",
      checks.length > 0 ? checks : "- No failing or pending checks reported",
    );
  } else {
    sections.push("", "Checks:", checks.length > 0 ? checks : "- No checks reported");
  }

  if (intent === "review-order" || intent === "summary" || intent === "focused") {
    sections.push("", "Changed files:", files.length > 0 ? files : reviewFilesFallback(payload));
  }

  if (intent === "conversation") {
    sections.push(
      "",
      "Recent conversation:",
      conversation.length > 0 ? conversation : "- No comments or reviews loaded",
    );
  }

  if (intent === "summary" || intent === "focused") {
    sections.push("", "Pull request description:", compactReviewBody(payload, 600));
  }

  return sections.join("\n");
}

export function buildReviewSidechatInitialPrompt(
  payload: ReviewSidechatContextPayload,
  question: string,
): string {
  return [buildReviewSidechatContextPrompt(payload, question), "", "User question:", question].join(
    "\n",
  );
}
