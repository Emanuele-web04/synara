import type {
  ReviewAddCommentInput,
  ReviewInlineComment,
  ReviewListPullRequestsInput,
  ReviewLocalComment,
  ReviewMoveProjectCardInput,
  ReviewProjectBoard,
  ReviewRemoveCommentInput,
  ReviewRunAgentInput,
  ReviewSourceRef,
  ReviewSubmitInput,
  ReviewTargetKey,
  ReviewUpdateCommentInput,
  ReviewUpdatedPayload,
} from "@t3tools/contracts";
import { type QueryClient, mutationOptions, queryOptions } from "@tanstack/react-query";
import { serializeReviewTargetKey } from "@t3tools/shared/reviewTargetKey";
import { ensureNativeApi } from "../nativeApi";

const REVIEW_LIST_STALE_TIME_MS = 30_000;
const REVIEW_LIST_REFETCH_INTERVAL_MS = 300_000;
const REVIEW_VIEWER_STALE_TIME_MS = 600_000;
const REVIEW_CHANGESET_STALE_TIME_MS = 30_000;
const REVIEW_PULL_REQUEST_STALE_TIME_MS = 30_000;
const REVIEW_CONVERSATION_STALE_TIME_MS = 30_000;
const REVIEW_COMMENTS_STALE_TIME_MS = 30_000;
const REVIEW_REMOTE_THREADS_STALE_TIME_MS = 30_000;
const REVIEW_PROJECT_ACCESS_STALE_TIME_MS = 300_000;
const REVIEW_PROJECTS_STALE_TIME_MS = 60_000;
const REVIEW_PROJECT_BOARD_STALE_TIME_MS = 30_000;

type ReviewListState = NonNullable<ReviewListPullRequestsInput["state"]>;

function reviewSourceKey(source: ReviewSourceRef): string {
  return source._tag === "pullRequest"
    ? `pullRequest:${source.reference}`
    : `branchRange:${source.base}...${source.head}`;
}

function reviewPullRequestListState(state?: ReviewListState): ReviewListState {
  return state ?? "open";
}

function reviewPullRequestListLimit(limit?: number): number | null {
  return limit ?? null;
}

export function applyReviewUpdatedPayload(
  queryClient: QueryClient,
  payload: ReviewUpdatedPayload,
): void {
  if (payload._tag === "pullRequestList") {
    queryClient.setQueryData(
      reviewQueryKeys.pullRequests(payload.cwd, payload.state, payload.limit),
      payload.data,
    );
    return;
  }
  if (payload._tag === "pullRequestOverview") {
    queryClient.setQueryData(
      reviewQueryKeys.pullRequest(payload.cwd, payload.reference),
      payload.data,
    );
    return;
  }
  if (payload._tag === "pullRequestConversation") {
    queryClient.setQueryData(
      reviewQueryKeys.conversation(payload.cwd, payload.reference),
      payload.data,
    );
    return;
  }
  queryClient.setQueryData(
    reviewQueryKeys.changeset(
      payload.cwd,
      reviewSourceKey({ _tag: "pullRequest", reference: payload.reference }),
    ),
    payload.data,
  );
}

export const reviewQueryKeys = {
  all: ["review"] as const,
  viewer: (cwd: string | null) => ["review", "viewer", "avatar-v2", cwd] as const,
  pullRequests: (cwd: string | null, state?: ReviewListState, limit?: number) =>
    [
      "review",
      "pull-requests",
      cwd,
      reviewPullRequestListState(state),
      reviewPullRequestListLimit(limit),
    ] as const,
  changeset: (cwd: string | null, sourceKey: string | null) =>
    ["review", "changeset", cwd, sourceKey] as const,
  pullRequest: (cwd: string | null, reference: string | null) =>
    ["review", "pull-request", cwd, reference] as const,
  conversation: (cwd: string | null, reference: string | null) =>
    ["review", "conversation", cwd, reference] as const,
  comments: (targetKey: string) => ["review", "comments", targetKey] as const,
  remoteThreads: (cwd: string | null, reference: string | null) =>
    ["review", "remote-threads", cwd, reference] as const,
  projectAccess: (cwd: string | null) => ["review", "project-access", cwd] as const,
  projects: (cwd: string | null, owner: string | null) =>
    ["review", "projects", cwd, owner] as const,
  projectBoard: (cwd: string | null, owner: string | null, number: number | null) =>
    ["review", "project-board", cwd, owner, number] as const,
};

export function reviewListPullRequestsQueryOptions(input: {
  cwd: string | null;
  state?: ReviewListState;
  limit?: number;
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.pullRequests(input.cwd, input.state, input.limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request list is unavailable.");
      return api.review.listPullRequests({
        cwd: input.cwd,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
    },
    enabled: input.cwd !== null,
    staleTime: REVIEW_LIST_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: REVIEW_LIST_REFETCH_INTERVAL_MS,
  });
}

export function reviewViewerQueryOptions(input: { cwd: string | null }) {
  return queryOptions({
    queryKey: reviewQueryKeys.viewer(input.cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Viewer is unavailable.");
      return api.review.getViewer({ cwd: input.cwd });
    },
    enabled: input.cwd !== null,
    staleTime: REVIEW_VIEWER_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewLoadChangesetQueryOptions(input: {
  cwd: string | null;
  source: ReviewSourceRef | null;
}) {
  const sourceKey = input.source ? reviewSourceKey(input.source) : null;
  return queryOptions({
    queryKey: reviewQueryKeys.changeset(input.cwd, sourceKey),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.source) {
        throw new Error("Changeset is unavailable.");
      }
      return api.review.loadChangeset({ cwd: input.cwd, source: input.source });
    },
    enabled: input.cwd !== null && input.source !== null,
    staleTime: REVIEW_CHANGESET_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewLoadPullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.pullRequest(input.cwd, input.reference),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request overview is unavailable.");
      }
      return api.review.loadPullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: REVIEW_PULL_REQUEST_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewLoadConversationQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.conversation(input.cwd, input.reference),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Conversation is unavailable.");
      }
      return api.review.loadConversation({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: REVIEW_CONVERSATION_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewListCommentsQueryOptions(input: { target: ReviewTargetKey | null }) {
  const targetKey = input.target ? serializeReviewTargetKey(input.target) : null;
  return queryOptions({
    queryKey: reviewQueryKeys.comments(targetKey ?? "none"),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.target) throw new Error("Review comments are unavailable.");
      return api.review.listComments({ target: input.target });
    },
    enabled: input.target !== null,
    staleTime: REVIEW_COMMENTS_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewLoadRemoteThreadsQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.remoteThreads(input.cwd, input.reference),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Submitted review threads are unavailable.");
      }
      return api.review.loadRemoteThreads({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: REVIEW_REMOTE_THREADS_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

function invalidateReviewComments(queryClient: QueryClient, target: ReviewTargetKey) {
  return queryClient.invalidateQueries({
    queryKey: reviewQueryKeys.comments(serializeReviewTargetKey(target)),
  });
}

function sameInlineComment(left: ReviewLocalComment, right: ReviewInlineComment): boolean {
  return (
    left.path === right.path &&
    left.line === right.line &&
    left.side === right.side &&
    left.body === right.body
  );
}

export async function clearSubmittedReviewComments(input: {
  queryClient: QueryClient;
  target: ReviewTargetKey;
  comments: ReadonlyArray<ReviewLocalComment>;
  skippedComments?: ReadonlyArray<ReviewInlineComment>;
}): Promise<void> {
  const skipped = input.skippedComments ?? [];
  const submitted = input.comments.filter(
    (comment) => !skipped.some((skippedComment) => sameInlineComment(comment, skippedComment)),
  );
  if (submitted.length === 0) {
    return;
  }
  const api = ensureNativeApi();
  await Promise.all(
    submitted.map((comment) => api.review.removeComment({ target: input.target, id: comment.id })),
  );
  await invalidateReviewComments(input.queryClient, input.target);
}

export function reviewSubmitMutationOptions(input: {
  queryClient: QueryClient;
  target: ReviewTargetKey | null;
}) {
  return mutationOptions({
    mutationKey: ["review", "submit"],
    mutationFn: async (args: ReviewSubmitInput) => ensureNativeApi().review.submit(args),
    onSettled: (_data, _error, args) => {
      void input.queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.conversation(args.cwd, args.reference),
      });
      void input.queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.remoteThreads(args.cwd, args.reference),
      });
      if (input.target) {
        void invalidateReviewComments(input.queryClient, input.target);
      }
    },
  });
}

export function reviewAddCommentMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["review", "add-comment"],
    mutationFn: async (args: ReviewAddCommentInput) => ensureNativeApi().review.addComment(args),
    onSettled: (_data, _error, args) => invalidateReviewComments(input.queryClient, args.target),
  });
}

export function reviewUpdateCommentMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["review", "update-comment"],
    mutationFn: async (args: ReviewUpdateCommentInput) =>
      ensureNativeApi().review.updateComment(args),
    onSettled: (_data, _error, args) => invalidateReviewComments(input.queryClient, args.target),
  });
}

export function reviewRemoveCommentMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["review", "remove-comment"],
    mutationFn: async (args: ReviewRemoveCommentInput) =>
      ensureNativeApi().review.removeComment(args),
    onSettled: (_data, _error, args) => invalidateReviewComments(input.queryClient, args.target),
  });
}

// Findings are session state held in the review store, so the result has no
// React Query cache to invalidate; the queryClient is accepted for parity with
// the other review mutations and future cache coordination.
export function reviewRunAgentMutationOptions(_input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["review", "run-agent"],
    mutationFn: async (args: ReviewRunAgentInput) => ensureNativeApi().review.runAgent(args),
  });
}

export function reviewCheckProjectAccessQueryOptions(input: { cwd: string | null }) {
  return queryOptions({
    queryKey: reviewQueryKeys.projectAccess(input.cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("GitHub Projects access is unavailable.");
      return api.review.checkProjectAccess({ cwd: input.cwd });
    },
    enabled: input.cwd !== null,
    staleTime: REVIEW_PROJECT_ACCESS_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewListProjectsQueryOptions(input: { cwd: string | null; owner?: string }) {
  return queryOptions({
    queryKey: reviewQueryKeys.projects(input.cwd, input.owner ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("GitHub Projects are unavailable.");
      return api.review.listProjects({
        cwd: input.cwd,
        ...(input.owner ? { owner: input.owner } : {}),
      });
    },
    enabled: input.cwd !== null,
    staleTime: REVIEW_PROJECTS_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function reviewProjectBoardQueryOptions(input: {
  cwd: string | null;
  owner: string | null;
  number: number | null;
}) {
  const enabled = input.cwd !== null && input.owner !== null && input.number !== null;
  return queryOptions({
    queryKey: reviewQueryKeys.projectBoard(input.cwd, input.owner, input.number),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (input.cwd === null || input.owner === null || input.number === null) {
        throw new Error("Project board is unavailable.");
      }
      return api.review.getProjectBoard({
        cwd: input.cwd,
        owner: input.owner,
        number: input.number,
      });
    },
    enabled,
    staleTime: REVIEW_PROJECT_BOARD_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

// Optimistic move flips the card's columnId in the cached board immediately,
// rolls back on error, and re-fetches the authoritative board onSettled.
export function reviewMoveProjectCardMutationOptions(input: {
  queryClient: QueryClient;
  cwd: string | null;
  owner: string | null;
  number: number | null;
}) {
  const boardKey = reviewQueryKeys.projectBoard(input.cwd, input.owner, input.number);
  return mutationOptions({
    mutationKey: ["review", "move-project-card"],
    mutationFn: async (args: ReviewMoveProjectCardInput) =>
      ensureNativeApi().review.moveProjectCard(args),
    onMutate: async (args: ReviewMoveProjectCardInput) => {
      await input.queryClient.cancelQueries({ queryKey: boardKey });
      const previous = input.queryClient.getQueryData<ReviewProjectBoard>(boardKey);
      if (previous) {
        input.queryClient.setQueryData<ReviewProjectBoard>(boardKey, {
          ...previous,
          cards: previous.cards.map((card) =>
            card.itemId === args.itemId ? { ...card, columnId: args.optionId } : card,
          ),
        });
      }
      return { previous };
    },
    onError: (_error, _args, context) => {
      const previous = (context as { previous?: ReviewProjectBoard } | undefined)?.previous;
      if (previous) {
        input.queryClient.setQueryData(boardKey, previous);
      }
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({ queryKey: boardKey });
    },
  });
}
