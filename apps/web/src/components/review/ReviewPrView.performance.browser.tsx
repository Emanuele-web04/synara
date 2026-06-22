import "../../index.css";

import type {
  ReviewPullRequestDetail,
  ReviewPullRequestHeaderDetail,
  ReviewSourceRef,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewPrView } from "./ReviewPrView";

const nativeApiMock = vi.hoisted(() => ({
  loadPullRequest: vi.fn(async () => ({
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
  })),
  loadPullRequestHeader: vi.fn(async () => ({
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
      reviewDecision: null,
      mergeable: "MERGEABLE" as const,
      milestone: null,
      labels: [],
      assignees: [],
      reviewers: [],
    },
  })),
  loadConversation: vi.fn(async () => ({ events: [] })),
  loadChangeset: vi.fn(async () => ({
    files: [],
    headSha: "abc123",
    patch: "",
    target: null,
  })),
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
    changeset: {
      files: [],
      headSha: "abc123",
      patch: "",
      target: null,
    },
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
      loadPullRequest: nativeApiMock.loadPullRequest,
      loadPullRequestHeader: nativeApiMock.loadPullRequestHeader,
      loadConversation: nativeApiMock.loadConversation,
      loadChangeset: nativeApiMock.loadChangeset,
      loadPullRequestSurface: nativeApiMock.loadPullRequestSurface,
    },
  }),
  readNativeApi: () => ({
    review: {
      loadPullRequest: nativeApiMock.loadPullRequest,
      loadPullRequestHeader: nativeApiMock.loadPullRequestHeader,
      loadConversation: nativeApiMock.loadConversation,
      loadChangeset: nativeApiMock.loadChangeset,
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

const HEADER_DETAIL = {
  number: DETAIL.number,
  title: DETAIL.title,
  url: DETAIL.url,
  state: DETAIL.state,
  isDraft: DETAIL.isDraft,
  author: DETAIL.author,
  baseBranch: DETAIL.baseBranch,
  headBranch: DETAIL.headBranch,
  body: DETAIL.body,
  createdAt: DETAIL.createdAt,
  updatedAt: DETAIL.updatedAt,
  additions: DETAIL.additions,
  deletions: DETAIL.deletions,
  changedFiles: DETAIL.changedFiles,
  reviewDecision: DETAIL.reviewDecision,
  mergeable: DETAIL.mergeable,
  milestone: DETAIL.milestone,
  labels: DETAIL.labels,
  assignees: DETAIL.assignees,
  reviewers: DETAIL.reviewers,
} satisfies ReviewPullRequestHeaderDetail;

function activeInfoOption(): HTMLElement {
  const panel = document
    .querySelector<HTMLElement>('[aria-label="Pull request readiness"]')
    ?.closest<HTMLElement>("aside");
  expect(panel).toBeTruthy();
  return panel!;
}

function exactTextElementWithin(root: HTMLElement, text: string): HTMLElement {
  const element = Array.from(root.querySelectorAll<HTMLElement>("*")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(element).toBeTruthy();
  return element!;
}

describe("ReviewPrView performance", () => {
  afterEach(() => {
    nativeApiMock.loadPullRequest.mockClear();
    nativeApiMock.loadPullRequestHeader.mockClear();
    nativeApiMock.loadConversation.mockClear();
    nativeApiMock.loadChangeset.mockClear();
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
    await page.viewport(1440, 800);
    const queuedFrame: { current: FrameRequestCallback | null } = { current: null };
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queuedFrame.current = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    nativeApiMock.loadPullRequestHeader.mockResolvedValueOnce({ detail: HEADER_DETAIL });

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
      expect(nativeApiMock.loadPullRequestHeader).toHaveBeenCalledTimes(1);
      expect(nativeApiMock.loadPullRequestHeader).toHaveBeenCalledWith({
        cwd: CWD,
        reference: REFERENCE,
      });
      expect(nativeApiMock.loadPullRequestSurface).toHaveBeenCalledTimes(0);
      expect(nativeApiMock.loadConversation).toHaveBeenCalledTimes(0);
      expect(nativeApiMock.loadPullRequest).toHaveBeenCalledTimes(0);
      expect(reviewChatThreadMock.prewarmReviewChatThread).toHaveBeenCalledTimes(1);
      expect(queuedFrame.current).not.toBeNull();

      queuedFrame.current?.(performance.now());

      await expect.poll(() => nativeApiMock.loadConversation.mock.calls.length).toBe(1);
      await expect.poll(() => nativeApiMock.loadPullRequest.mock.calls.length).toBe(1);
      expect(nativeApiMock.loadConversation).toHaveBeenCalledWith({
        cwd: CWD,
        reference: REFERENCE,
      });
      expect(nativeApiMock.loadPullRequest).toHaveBeenCalledWith({
        cwd: CWD,
        reference: REFERENCE,
      });
      expect(nativeApiMock.loadPullRequestSurface).toHaveBeenCalledTimes(0);
      expect(nativeApiMock.loadChangeset).toHaveBeenCalledTimes(0);
      await page.getByRole("tab", { name: "Info" }).click();
      const commitsRow = exactTextElementWithin(activeInfoOption(), "Commits").closest("div");
      expect(commitsRow?.textContent).toContain("1");
      expect(commitsRow?.textContent).not.toContain("Loading");
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });

  it("hydrates files through the aggregate surface query after the first overview frame", async () => {
    await page.viewport(1200, 800);
    const queuedFrame: { current: FrameRequestCallback | null } = { current: null };
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queuedFrame.current = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    nativeApiMock.loadPullRequestHeader.mockResolvedValueOnce({ detail: HEADER_DETAIL });

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
      expect(queuedFrame.current).not.toBeNull();
      queuedFrame.current?.(performance.now());
      await expect.poll(() => nativeApiMock.loadConversation.mock.calls.length).toBe(1);
      await expect.poll(() => nativeApiMock.loadPullRequest.mock.calls.length).toBe(1);
      nativeApiMock.loadPullRequestSurface.mockClear();
      nativeApiMock.loadPullRequest.mockClear();
      nativeApiMock.loadConversation.mockClear();

      await page.getByRole("button", { name: "Review changes" }).click();

      await expect.poll(() => nativeApiMock.loadPullRequestSurface.mock.calls.length).toBe(1);
      expect(reviewChatThreadMock.prewarmReviewChatThread).toHaveBeenCalledTimes(1);
      expect(nativeApiMock.loadPullRequestSurface).toHaveBeenCalledWith({
        cwd: CWD,
        reference: REFERENCE,
        source: SOURCE,
        includeChangeset: true,
      });
      expect(nativeApiMock.loadChangeset).toHaveBeenCalledTimes(0);
      expect(nativeApiMock.loadConversation).toHaveBeenCalledTimes(0);
      expect(nativeApiMock.loadPullRequest).toHaveBeenCalledTimes(0);
    } finally {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    }
  });
});
