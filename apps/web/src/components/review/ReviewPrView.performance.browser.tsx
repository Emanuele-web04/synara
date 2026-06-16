import "../../index.css";

import type { ReviewPullRequestDetail, ReviewSourceRef } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { reviewQueryKeys } from "~/lib/reviewReactQuery";
import { ReviewPrView } from "./ReviewPrView";

const nativeApiMock = vi.hoisted(() => ({
  loadPullRequestSurface: vi.fn(async () => ({
    overview: {
      detail: {
        number: 42,
        title: "Speed up review loading",
        url: "https://github.com/acme/repo/pull/42",
        state: "open" as const,
        isDraft: false,
        author: "alice",
        baseBranch: "main",
        headBranch: "feature/review-loading",
        body: "Review body",
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        commitsCount: 1,
        reviewDecision: null,
        mergeable: "MERGEABLE" as const,
        checksStatus: "passing" as const,
        milestone: null,
        labels: [],
        assignees: [],
        reviewers: [],
      },
      commits: [],
      checks: [],
    },
    conversation: { events: [] },
  })),
}));

const reviewChatThreadMock = vi.hoisted(() => ({
  REVIEW_RISKS_NATIVE_REVIEW_QUESTION: "Find review risks",
  buildReviewChatTarget: vi.fn(() => null),
  defaultReviewChatModelSelection: vi.fn(() => ({
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    options: { reasoningEffort: "low" },
  })),
  findProjectForReviewChat: vi.fn(() => null),
  findReviewChatThread: vi.fn(() => null),
  prewarmReviewChatThread: vi.fn(async () => ({
    status: "unavailable" as const,
    reason: "No Synara project is open for this repository.",
  })),
  resolveOrCreateReviewChatThread: vi.fn(async () => ({
    status: "unavailable" as const,
    reason: "No Synara project is open for this repository.",
  })),
  reviewChatTargetKey: vi.fn(() => "review-chat-target"),
  reviewChatTargetsEqual: vi.fn(() => false),
  sendReviewChatQuestion: vi.fn(async () => ({
    status: "unavailable" as const,
    reason: "No Synara project is open for this repository.",
  })),
  startNewReviewChatThread: vi.fn(async () => ({
    status: "unavailable" as const,
    reason: "No Synara project is open for this repository.",
  })),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    review: {
      loadPullRequestSurface: nativeApiMock.loadPullRequestSurface,
    },
  }),
  readNativeApi: () => ({
    review: {
      loadPullRequestSurface: nativeApiMock.loadPullRequestSurface,
    },
  }),
}));

vi.mock("~/lib/reviewChatThread", () => reviewChatThreadMock);

const CWD = "/repo";
const REFERENCE = "42";
const SOURCE = { _tag: "pullRequest", reference: REFERENCE } satisfies ReviewSourceRef;

const DETAIL = {
  number: 42,
  title: "Speed up review loading",
  url: "https://github.com/acme/repo/pull/42",
  state: "open",
  isDraft: false,
  author: "alice",
  baseBranch: "main",
  headBranch: "feature/review-loading",
  body: "Review body",
  createdAt: "2026-06-16T00:00:00.000Z",
  updatedAt: "2026-06-16T00:00:00.000Z",
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  commitsCount: 1,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  checksStatus: "passing",
  milestone: null,
  labels: [],
  assignees: [],
  reviewers: [],
} satisfies ReviewPullRequestDetail;

describe("ReviewPrView performance", () => {
  afterEach(() => {
    nativeApiMock.loadPullRequestSurface.mockClear();
    reviewChatThreadMock.buildReviewChatTarget.mockClear();
    reviewChatThreadMock.defaultReviewChatModelSelection.mockClear();
    reviewChatThreadMock.findProjectForReviewChat.mockClear();
    reviewChatThreadMock.findReviewChatThread.mockClear();
    reviewChatThreadMock.prewarmReviewChatThread.mockClear();
    reviewChatThreadMock.resolveOrCreateReviewChatThread.mockClear();
    reviewChatThreadMock.reviewChatTargetKey.mockClear();
    reviewChatThreadMock.reviewChatTargetsEqual.mockClear();
    reviewChatThreadMock.sendReviewChatQuestion.mockClear();
    reviewChatThreadMock.startNewReviewChatThread.mockClear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("defers conversation hydration until after the first overview frame", async () => {
    await page.viewport(1200, 800);
    let queuedFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(reviewQueryKeys.pullRequest(CWD, REFERENCE), {
      detail: DETAIL,
      commits: [],
      checks: [],
    });

    const host = document.createElement("div");
    host.className = "flex h-[800px] bg-background text-foreground";
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ReviewPrView cwd={CWD} reference={REFERENCE} source={SOURCE} />
      </QueryClientProvider>,
      { container: host },
    );

    try {
      await expect.element(page.getByRole("heading", { name: DETAIL.title })).toBeVisible();
      expect(nativeApiMock.loadPullRequestSurface).toHaveBeenCalledTimes(0);
      expect(queuedFrame).not.toBeNull();

      queuedFrame?.(performance.now());

      await expect.poll(() => nativeApiMock.loadPullRequestSurface.mock.calls.length).toBe(1);
      expect(nativeApiMock.loadPullRequestSurface).toHaveBeenCalledWith({
        cwd: CWD,
        reference: REFERENCE,
        source: SOURCE,
        includeConversation: true,
      });
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });
});
