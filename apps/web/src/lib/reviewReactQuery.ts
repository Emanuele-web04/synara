import type {
  ReviewAddCommentInput,
  ReviewBoardLanesResult,
  ReviewInlineComment,
  ReviewListPullRequestsInput,
  ReviewListSort,
  ReviewLocalComment,
  ReviewMoveProjectCardInput,
  ReviewProjectBoard,
  ReviewRemoveCommentInput,
  ReviewPullRequestHeader,
  ReviewPullRequestOverview,
  ReviewPullRequestSurfaceInput,
  ReviewPullRequestSurfaceResult,
  ReviewGenerateWalkthroughInput,
  ReviewRunAgentInput,
  ReviewSourceRef,
  ReviewSubmitInput,
  ReviewTargetKey,
  ReviewUpdateCommentInput,
  ReviewUpdatedPayload,
  ReviewWalkthroughResult,
} from "@t3tools/contracts";
import { type QueryClient, mutationOptions, queryOptions } from "@tanstack/react-query";
import { serializeReviewTargetKey } from "@t3tools/shared/reviewTargetKey";
import { ensureNativeApi } from "../nativeApi";

const REVIEW_LIST_STALE_TIME_MS = 300_000;
const REVIEW_BOARD_LANES_STALE_TIME_MS = 300_000;
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
const REVIEW_WALKTHROUGH_GC_TIME_MS = 60 * 60_000;

type ReviewListState = NonNullable<ReviewListPullRequestsInput["state"]>;
type ReviewListColumn = NonNullable<ReviewListPullRequestsInput["columns"]>[number];
type ReviewListChecksStatus = NonNullable<ReviewListPullRequestsInput["checks"]>[number];
type ReviewListSortId = ReviewListSort;

export function reviewSourceKey(source: ReviewSourceRef): string {
  return source._tag === "pullRequest"
    ? `pullRequest:${source.reference}`
    : `branchRange:${source.base}...${source.head}`;
}

function pullRequestHeaderFromOverview(
  overview: ReviewPullRequestOverview,
): ReviewPullRequestHeader {
  return { detail: overview.detail };
}

function reviewPullRequestListState(state?: ReviewListState): ReviewListState {
  return state ?? "open";
}

function reviewPullRequestListLimit(limit?: number): number | null {
  return limit ?? null;
}

function reviewPullRequestListText(value?: string): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function reviewPullRequestListValues<T extends string>(
  values?: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (!values || values.length === 0) {
    return [];
  }
  return [...new Set(values)].sort();
}

function reviewPullRequestListTextValues(values?: ReadonlyArray<string>): ReadonlyArray<string> {
  if (!values || values.length === 0) {
    return [];
  }
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

function reviewPullRequestListSort(sort?: ReviewListSortId): ReviewListSortId | null {
  return sort ?? null;
}

export function applyReviewUpdatedPayload(
  queryClient: QueryClient,
  payload: ReviewUpdatedPayload,
): void {
  if (payload._tag === "pullRequestList") {
    queryClient.setQueryData(
      reviewQueryKeys.pullRequests({
        cwd: payload.cwd,
        state: payload.state,
        limit: payload.limit,
        search: payload.search,
        author: payload.author,
        authors: payload.authors,
        reviewRequested: payload.reviewRequested,
        baseBranch: payload.baseBranch,
        baseBranches: payload.baseBranches,
        headBranch: payload.headBranch,
        headBranches: payload.headBranches,
        label: payload.label,
        labels: payload.labels,
        assignee: payload.assignee,
        assignees: payload.assignees,
        draft: payload.draft,
        columns: payload.columns,
        checks: payload.checks,
        sort: payload.sort,
      }),
      payload.data,
    );
    return;
  }
  if (payload._tag === "pullRequestOverview") {
    queryClient.setQueryData(
      reviewQueryKeys.pullRequest(payload.cwd, payload.reference),
      payload.data,
    );
    queryClient.setQueryData(
      reviewQueryKeys.pullRequestHeader(payload.cwd, payload.reference),
      pullRequestHeaderFromOverview(payload.data),
    );
    updateReviewPullRequestSurfaceCaches(queryClient, payload.cwd, payload.reference, {
      overview: payload.data,
    });
    return;
  }
  if (payload._tag === "pullRequestConversation") {
    queryClient.setQueryData(
      reviewQueryKeys.conversation(payload.cwd, payload.reference),
      payload.data,
    );
    updateReviewPullRequestSurfaceCaches(queryClient, payload.cwd, payload.reference, {
      conversation: payload.data,
    });
    return;
  }
  if (payload._tag === "pullRequestWalkthrough") {
    const patchSignature = payload.data.patchSignature;
    if (patchSignature !== undefined) {
      const expectedHeadSha = payload.data.reviewedHeadSha ?? null;
      const walkthroughResult = {
        walkthrough: payload.data,
        ...(payload.data.reviewedHeadSha !== undefined
          ? { reviewedHeadSha: payload.data.reviewedHeadSha }
          : {}),
        patchSignature,
        ...(payload.data.patchSource !== undefined
          ? { patchSource: payload.data.patchSource }
          : {}),
        headMoved: false,
        patchChanged: false,
      } satisfies ReviewWalkthroughResult;
      queryClient.setQueryData(
        reviewQueryKeys.walkthrough(
          payload.cwd,
          payload.reference,
          patchSignature,
          expectedHeadSha,
        ),
        walkthroughResult,
      );
      queryClient.setQueriesData<ReviewWalkthroughResult>(
        {
          queryKey: [
            "review",
            "walkthrough",
            payload.cwd,
            payload.reference,
            patchSignature,
            expectedHeadSha,
          ],
          exact: false,
        },
        walkthroughResult,
      );
    }
    return;
  }
  if (payload._tag === "boardLanes") {
    void queryClient.invalidateQueries({
      queryKey: reviewQueryKeys.boardLanesByCwd(payload.cwd),
    });
    void queryClient.invalidateQueries({
      queryKey: reviewQueryKeys.pullRequestLists(payload.cwd),
    });
    return;
  }
  queryClient.setQueryData(
    reviewQueryKeys.changeset(
      payload.cwd,
      reviewSourceKey({ _tag: "pullRequest", reference: payload.reference }),
    ),
    payload.data,
  );
  updateReviewPullRequestSurfaceCaches(queryClient, payload.cwd, payload.reference, {
    changeset: payload.data,
  });
}

function updateReviewPullRequestSurfaceCaches(
  queryClient: QueryClient,
  cwd: string,
  reference: string,
  patch: Partial<ReviewPullRequestSurfaceResult>,
): void {
  queryClient.setQueriesData<ReviewPullRequestSurfaceResult>(
    { queryKey: reviewQueryKeys.pullRequestSurfaces(cwd, reference) },
    (current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        ...(patch.overview !== undefined ? { overview: patch.overview } : {}),
        ...(patch.conversation !== undefined && current.conversation !== undefined
          ? { conversation: patch.conversation }
          : {}),
        ...(patch.changeset !== undefined && current.changeset !== undefined
          ? { changeset: patch.changeset }
          : {}),
      };
    },
  );
}

export function applyReviewPullRequestSurfacePayload(
  queryClient: QueryClient,
  input: ReviewPullRequestSurfaceInput,
  payload: ReviewPullRequestSurfaceResult,
): void {
  queryClient.setQueryData(
    reviewQueryKeys.pullRequest(input.cwd, input.reference),
    payload.overview,
  );
  queryClient.setQueryData(
    reviewQueryKeys.pullRequestHeader(input.cwd, input.reference),
    pullRequestHeaderFromOverview(payload.overview),
  );
  if (payload.conversation !== undefined) {
    queryClient.setQueryData(
      reviewQueryKeys.conversation(input.cwd, input.reference),
      payload.conversation,
    );
  }
  if (payload.changeset !== undefined) {
    queryClient.setQueryData(
      reviewQueryKeys.changeset(input.cwd, reviewSourceKey(input.source)),
      payload.changeset,
    );
  }
}

export const reviewQueryKeys = {
  all: ["review"] as const,
  viewer: (cwd: string | null) => ["review", "viewer", "avatar-v2", cwd] as const,
  pullRequestLists: (cwd: string | null) => ["review", "pull-requests", cwd] as const,
  boardLanesByCwd: (cwd: string | null) => ["review", "board-lanes", cwd] as const,
  boardLanes: (cwd: string | null, limit?: number) =>
    ["review", "board-lanes", cwd, reviewPullRequestListLimit(limit)] as const,
  pullRequests: (input: {
    cwd: string | null;
    state?: ReviewListState | undefined;
    limit?: number | undefined;
    search?: string | undefined;
    author?: string | undefined;
    authors?: ReadonlyArray<string> | undefined;
    reviewRequested?: string | undefined;
    baseBranch?: string | undefined;
    baseBranches?: ReadonlyArray<string> | undefined;
    headBranch?: string | undefined;
    headBranches?: ReadonlyArray<string> | undefined;
    label?: string | undefined;
    labels?: ReadonlyArray<string> | undefined;
    assignee?: string | undefined;
    assignees?: ReadonlyArray<string> | undefined;
    draft?: boolean | undefined;
    columns?: ReadonlyArray<ReviewListColumn> | undefined;
    checks?: ReadonlyArray<ReviewListChecksStatus> | undefined;
    sort?: ReviewListSortId | undefined;
  }) =>
    [
      ...reviewQueryKeys.pullRequestLists(input.cwd),
      reviewPullRequestListState(input.state),
      reviewPullRequestListLimit(input.limit),
      reviewPullRequestListText(input.search),
      reviewPullRequestListText(input.author),
      reviewPullRequestListTextValues(input.authors),
      reviewPullRequestListText(input.reviewRequested),
      reviewPullRequestListText(input.baseBranch),
      reviewPullRequestListTextValues(input.baseBranches),
      reviewPullRequestListText(input.headBranch),
      reviewPullRequestListTextValues(input.headBranches),
      reviewPullRequestListText(input.label),
      reviewPullRequestListTextValues(input.labels),
      reviewPullRequestListText(input.assignee),
      reviewPullRequestListTextValues(input.assignees),
      input.draft === true ? true : null,
      reviewPullRequestListValues(input.columns),
      reviewPullRequestListValues(input.checks),
      reviewPullRequestListSort(input.sort),
    ] as const,
  changeset: (cwd: string | null, sourceKey: string | null) =>
    ["review", "changeset", cwd, sourceKey] as const,
  pullRequest: (cwd: string | null, reference: string | null) =>
    ["review", "pull-request", cwd, reference] as const,
  pullRequestHeader: (cwd: string | null, reference: string | null) =>
    ["review", "pull-request-header", cwd, reference] as const,
  pullRequestSurfaces: (cwd: string | null, reference: string | null) =>
    ["review", "pull-request-surface", cwd, reference] as const,
  pullRequestSurface: (
    cwd: string | null,
    reference: string | null,
    sourceKey: string | null,
    includeConversation: boolean,
    includeChangeset: boolean,
  ) =>
    [
      "review",
      "pull-request-surface",
      cwd,
      reference,
      sourceKey,
      includeConversation,
      includeChangeset,
    ] as const,
  walkthrough: (
    cwd: string | null,
    reference: string | null,
    patchSignature: string | null,
    expectedHeadSha: string | null,
    generationSettings: unknown = null,
  ) =>
    [
      "review",
      "walkthrough",
      cwd,
      reference,
      patchSignature,
      expectedHeadSha,
      generationSettings,
    ] as const,
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
  search?: string;
  author?: string;
  authors?: ReadonlyArray<string>;
  reviewRequested?: string;
  baseBranch?: string;
  baseBranches?: ReadonlyArray<string>;
  headBranch?: string;
  headBranches?: ReadonlyArray<string>;
  label?: string;
  labels?: ReadonlyArray<string>;
  assignee?: string;
  assignees?: ReadonlyArray<string>;
  draft?: boolean;
  columns?: ReadonlyArray<ReviewListColumn>;
  checks?: ReadonlyArray<ReviewListChecksStatus>;
  sort?: ReviewListSortId;
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.pullRequests(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request list is unavailable.");
      return api.review.listPullRequests(
        buildReviewListPullRequestsRequest({ ...input, cwd: input.cwd }),
      );
    },
    enabled: input.cwd !== null,
    staleTime: REVIEW_LIST_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchInterval: REVIEW_LIST_REFETCH_INTERVAL_MS,
  });
}

export function reviewLoadBoardLanesQueryOptions(input: { cwd: string | null; limit?: number }) {
  return queryOptions({
    queryKey: reviewQueryKeys.boardLanes(input.cwd, input.limit),
    queryFn: async (): Promise<ReviewBoardLanesResult> => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Review board lanes are unavailable.");
      return api.review.loadBoardLanes({
        cwd: input.cwd,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
    },
    enabled: input.cwd !== null,
    staleTime: REVIEW_BOARD_LANES_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchInterval: REVIEW_LIST_REFETCH_INTERVAL_MS,
  });
}

export function buildReviewListPullRequestsRequest(input: {
  cwd: string;
  state?: ReviewListState;
  limit?: number;
  search?: string;
  author?: string;
  authors?: ReadonlyArray<string>;
  reviewRequested?: string;
  baseBranch?: string;
  baseBranches?: ReadonlyArray<string>;
  headBranch?: string;
  headBranches?: ReadonlyArray<string>;
  label?: string;
  labels?: ReadonlyArray<string>;
  assignee?: string;
  assignees?: ReadonlyArray<string>;
  draft?: boolean;
  columns?: ReadonlyArray<ReviewListColumn>;
  checks?: ReadonlyArray<ReviewListChecksStatus>;
  sort?: ReviewListSortId;
}): ReviewListPullRequestsInput {
  const search = reviewPullRequestListText(input.search);
  const author = reviewPullRequestListText(input.author);
  const authors = reviewPullRequestListTextValues(input.authors);
  const reviewRequested = reviewPullRequestListText(input.reviewRequested);
  const baseBranch = reviewPullRequestListText(input.baseBranch);
  const baseBranches = reviewPullRequestListTextValues(input.baseBranches);
  const headBranch = reviewPullRequestListText(input.headBranch);
  const headBranches = reviewPullRequestListTextValues(input.headBranches);
  const label = reviewPullRequestListText(input.label);
  const labels = reviewPullRequestListTextValues(input.labels);
  const assignee = reviewPullRequestListText(input.assignee);
  const assignees = reviewPullRequestListTextValues(input.assignees);
  const columns = reviewPullRequestListValues(input.columns);
  const checks = reviewPullRequestListValues(input.checks);
  return {
    cwd: input.cwd,
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(search !== null ? { search } : {}),
    ...(author !== null ? { author } : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(reviewRequested !== null ? { reviewRequested } : {}),
    ...(baseBranch !== null ? { baseBranch } : {}),
    ...(baseBranches.length > 0 ? { baseBranches } : {}),
    ...(headBranch !== null ? { headBranch } : {}),
    ...(headBranches.length > 0 ? { headBranches } : {}),
    ...(label !== null ? { label } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(assignee !== null ? { assignee } : {}),
    ...(assignees.length > 0 ? { assignees } : {}),
    ...(input.draft === true ? { draft: true } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    ...(checks.length > 0 ? { checks } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
  };
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

export function reviewGenerateWalkthroughQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
  source: ReviewSourceRef | null;
  patchSignature: string | null;
  expectedHeadSha?: string;
  codexHomePath?: ReviewGenerateWalkthroughInput["codexHomePath"];
  providerOptions?: ReviewGenerateWalkthroughInput["providerOptions"];
  modelSelection?: ReviewGenerateWalkthroughInput["modelSelection"];
  textGenerationModel?: ReviewGenerateWalkthroughInput["textGenerationModel"];
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.walkthrough(
      input.cwd,
      input.reference,
      input.patchSignature,
      input.expectedHeadSha ?? null,
      {
        codexHomePath: input.codexHomePath ?? null,
        providerOptions: input.providerOptions ?? null,
        modelSelection: input.modelSelection ?? null,
        textGenerationModel: input.textGenerationModel ?? null,
      },
    ),
    queryFn: async (): Promise<ReviewWalkthroughResult> => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.source || input.patchSignature === null) {
        throw new Error("Walkthrough is unavailable.");
      }
      return api.review.generateWalkthrough({
        cwd: input.cwd,
        source: input.source,
        expectedPatchSignature: input.patchSignature,
        ...(input.expectedHeadSha !== undefined ? { expectedHeadSha: input.expectedHeadSha } : {}),
        ...(input.codexHomePath !== undefined ? { codexHomePath: input.codexHomePath } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(input.textGenerationModel !== undefined
          ? { textGenerationModel: input.textGenerationModel }
          : {}),
      });
    },
    enabled:
      input.cwd !== null &&
      input.reference !== null &&
      input.source !== null &&
      input.patchSignature !== null,
    staleTime: Infinity,
    gcTime: REVIEW_WALKTHROUGH_GC_TIME_MS,
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
      return api.review.loadPullRequest({
        cwd: input.cwd,
        reference: input.reference,
      });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: REVIEW_PULL_REQUEST_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewLoadPullRequestHeaderQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: reviewQueryKeys.pullRequestHeader(input.cwd, input.reference),
    queryFn: async (): Promise<ReviewPullRequestHeader> => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request header is unavailable.");
      }
      return api.review.loadPullRequestHeader({
        cwd: input.cwd,
        reference: input.reference,
      });
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
      return api.review.loadConversation({
        cwd: input.cwd,
        reference: input.reference,
      });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: REVIEW_CONVERSATION_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function reviewLoadPullRequestSurfaceQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
  source: ReviewSourceRef | null;
  includeConversation: boolean;
  includeChangeset: boolean;
  queryClient: QueryClient;
}) {
  const sourceKey = input.source ? reviewSourceKey(input.source) : null;
  return queryOptions({
    queryKey: reviewQueryKeys.pullRequestSurface(
      input.cwd,
      input.reference,
      sourceKey,
      input.includeConversation,
      input.includeChangeset,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference || !input.source) {
        throw new Error("Pull request surface is unavailable.");
      }
      const request: ReviewPullRequestSurfaceInput = {
        cwd: input.cwd,
        reference: input.reference,
        source: input.source,
        ...(input.includeConversation ? { includeConversation: true } : {}),
        ...(input.includeChangeset ? { includeChangeset: true } : {}),
      };
      const payload = await api.review.loadPullRequestSurface(request);
      applyReviewPullRequestSurfacePayload(input.queryClient, request, payload);
      return payload;
    },
    enabled:
      input.cwd !== null &&
      input.reference !== null &&
      input.source !== null &&
      (input.includeConversation || input.includeChangeset),
    staleTime: REVIEW_PULL_REQUEST_STALE_TIME_MS,
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
      return api.review.loadRemoteThreads({
        cwd: input.cwd,
        reference: input.reference,
      });
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

function invalidateReviewPullRequestCaches(
  queryClient: QueryClient,
  cwd: string,
  reference: string,
): void {
  void queryClient.invalidateQueries({ queryKey: reviewQueryKeys.pullRequest(cwd, reference) });
  void queryClient.invalidateQueries({
    queryKey: reviewQueryKeys.pullRequestHeader(cwd, reference),
  });
  void queryClient.invalidateQueries({
    queryKey: reviewQueryKeys.pullRequestSurfaces(cwd, reference),
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
      invalidateReviewPullRequestCaches(input.queryClient, args.cwd, args.reference);
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

export function reviewResolveThreadMutationOptions(input: {
  queryClient: QueryClient;
  cwd: string | null;
  reference: string | null;
}) {
  return mutationOptions({
    mutationKey: ["review", "resolve-thread"],
    mutationFn: async (args: { threadId: string; resolved: boolean }) => {
      if (!input.cwd || !input.reference) {
        throw new Error("Review thread is unavailable.");
      }
      return ensureNativeApi().review.resolveThread({
        cwd: input.cwd,
        reference: input.reference,
        threadId: args.threadId,
        resolved: args.resolved,
      });
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.remoteThreads(input.cwd, input.reference),
      });
    },
  });
}

export function reviewReplyThreadMutationOptions(input: {
  queryClient: QueryClient;
  cwd: string | null;
  reference: string | null;
}) {
  return mutationOptions({
    mutationKey: ["review", "reply-thread"],
    mutationFn: async (args: { threadId: string; body: string }) => {
      if (!input.cwd || !input.reference) {
        throw new Error("Review thread is unavailable.");
      }
      return ensureNativeApi().review.replyThread({
        cwd: input.cwd,
        reference: input.reference,
        threadId: args.threadId,
        body: args.body,
      });
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.remoteThreads(input.cwd, input.reference),
      });
    },
  });
}

export function reviewUpdateThreadCommentMutationOptions(input: {
  queryClient: QueryClient;
  cwd: string | null;
  reference: string | null;
}) {
  return mutationOptions({
    mutationKey: ["review", "update-thread-comment"],
    mutationFn: async (args: { commentId: string; body: string }) => {
      if (!input.cwd || !input.reference) {
        throw new Error("Review comment is unavailable.");
      }
      return ensureNativeApi().review.updateThreadComment({
        cwd: input.cwd,
        reference: input.reference,
        commentId: args.commentId,
        body: args.body,
      });
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.remoteThreads(input.cwd, input.reference),
      });
    },
  });
}

export function reviewDeleteThreadCommentMutationOptions(input: {
  queryClient: QueryClient;
  cwd: string | null;
  reference: string | null;
}) {
  return mutationOptions({
    mutationKey: ["review", "delete-thread-comment"],
    mutationFn: async (args: { commentId: string }) => {
      if (!input.cwd || !input.reference) {
        throw new Error("Review comment is unavailable.");
      }
      return ensureNativeApi().review.deleteThreadComment({
        cwd: input.cwd,
        reference: input.reference,
        commentId: args.commentId,
      });
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({
        queryKey: reviewQueryKeys.remoteThreads(input.cwd, input.reference),
      });
    },
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
