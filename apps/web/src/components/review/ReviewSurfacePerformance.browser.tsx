import "../../index.css";

import type { ReviewBoardLanesResult, ReviewPullRequestSummary } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewBoard } from "./ReviewBoard";
import { ReviewBoardCard } from "./ReviewBoardCard";

const navigateMock = vi.hoisted(() => vi.fn());
const nativeApiMock = vi.hoisted(() => ({
  getViewer: vi.fn(async () => ({ login: "tyler" })),
  loadBoardLanes: vi.fn(
    async (): Promise<ReviewBoardLanesResult> => ({
      "needs-review": { pullRequests: [] },
      "changes-requested": { pullRequests: [] },
      approved: { pullRequests: [] },
      draft: { pullRequests: [] },
    }),
  ),
  listPullRequests: vi.fn(async () => ({ pullRequests: [] as ReviewPullRequestSummary[] })),
}));
const REVIEW_BENCHMARK_INITIAL_LIMIT = 50;
const MIN_REVIEW_SURFACE_REDUCTION = 10;

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    review: {
      getViewer: nativeApiMock.getViewer,
      loadBoardLanes: nativeApiMock.loadBoardLanes,
      listPullRequests: nativeApiMock.listPullRequests,
    },
  }),
}));

function makePullRequests(count: number): ReviewPullRequestSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Review benchmark PR ${String(index + 1)}`,
    url: `https://github.com/acme/repo/pull/${String(index + 1)}`,
    baseBranch: "main",
    headBranch: `branch-${String(index + 1)}`,
    author: index % 5 === 0 ? "tyler" : "alice",
    updatedAt: "2026-06-16T00:00:00.000Z",
    state: "open",
    reviewDecision: null,
    isDraft: false,
    additions: 1,
    deletions: 0,
    checksStatus: "pending",
    reviewRequests: [],
    labels: [],
    assignees: [],
  }));
}

function NaiveReviewBoard(props: { pullRequests: ReadonlyArray<ReviewPullRequestSummary> }) {
  return (
    <section
      aria-label="Naive pull request board"
      className="flex h-[900px] w-72 flex-col gap-2 overflow-y-auto rounded-[1.5rem] border border-border/60 bg-card/55 p-2.5"
    >
      <h2 className="shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Needs Review
      </h2>
      <ul className="flex flex-col gap-2">
        {props.pullRequests.map((pullRequest) => (
          <li key={pullRequest.number} className="h-32 shrink-0">
            <ReviewBoardCard pullRequest={pullRequest} cwd="/repo" />
          </li>
        ))}
      </ul>
    </section>
  );
}

async function mountNaiveBoard(pullRequests: ReadonlyArray<ReviewPullRequestSummary>) {
  const host = document.createElement("div");
  document.body.append(host);
  const startedAt = performance.now();
  const screen = await render(<NaiveReviewBoard pullRequests={pullRequests} />, {
    container: host,
  });
  const elapsedMs = performance.now() - startedAt;

  return {
    elapsedMs,
    rows: host.querySelectorAll("li").length,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function mountOptimizedBoard(pullRequests: ReadonlyArray<ReviewPullRequestSummary>) {
  await page.viewport(1440, 900);
  nativeApiMock.getViewer.mockResolvedValue({ login: "tyler" });
  let optimizedResultRows = 0;
  nativeApiMock.loadBoardLanes.mockImplementation(async () => {
    const resultLimit = REVIEW_BENCHMARK_INITIAL_LIMIT;
    const boundedPullRequests = pullRequests.slice(0, resultLimit);
    optimizedResultRows += boundedPullRequests.length;
    return {
      "needs-review": {
        pullRequests: boundedPullRequests,
        meta: {
          resultLimit,
          candidateLimit: pullRequests.length,
          candidateCount: pullRequests.length,
          candidateLimitReached: false,
          matchedCount: pullRequests.length,
          returnedCount: boundedPullRequests.length,
          bounded: true,
        },
      },
      "changes-requested": { pullRequests: [] },
      approved: { pullRequests: [] },
      draft: { pullRequests: [] },
    };
  });
  const host = document.createElement("div");
  host.className = "h-[900px] bg-background text-foreground";
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const startedAt = performance.now();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ReviewBoard cwd="/repo" />
    </QueryClientProvider>,
    { container: host },
  );
  await expect
    .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
    .toBeVisible();
  await expect.element(page.getByText("Review benchmark PR 1", { exact: true })).toBeVisible();
  const elapsedMs = performance.now() - startedAt;

  return {
    elapsedMs,
    resultRows: optimizedResultRows,
    rows: host.querySelectorAll('[role="listitem"]').length,
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("review surface performance benchmark", () => {
  afterEach(() => {
    nativeApiMock.getViewer.mockClear();
    nativeApiMock.loadBoardLanes.mockClear();
    nativeApiMock.listPullRequests.mockClear();
    navigateMock.mockClear();
    document.body.innerHTML = "";
  });

  it("keeps review-board mounted row work at least 10x below naive rendering", async () => {
    const pullRequests = makePullRequests(5000);

    const naive = await mountNaiveBoard(pullRequests);
    await naive.cleanup();

    const optimized = await mountOptimizedBoard(pullRequests);
    try {
      const mountedRowReduction = naive.rows / Math.max(optimized.rows, 1);
      const dataReadyReduction = pullRequests.length / Math.max(optimized.resultRows, 1);
      const elapsedReduction = naive.elapsedMs / Math.max(optimized.elapsedMs, 1);
      const benchmark = {
        inputRows: pullRequests.length,
        naiveRows: naive.rows,
        optimizedResultRows: optimized.resultRows,
        optimizedRows: optimized.rows,
        dataReadyReduction,
        mountedRowReduction,
        elapsedReduction,
        naiveElapsedMs: Math.round(naive.elapsedMs),
        optimizedElapsedMs: Math.round(optimized.elapsedMs),
        boardLaneCalls: nativeApiMock.loadBoardLanes.mock.calls.length,
        listCalls: nativeApiMock.listPullRequests.mock.calls.length,
        viewerCalls: nativeApiMock.getViewer.mock.calls.length,
      };
      console.info("[benchmark] review surface board", JSON.stringify(benchmark));

      expect(nativeApiMock.getViewer).toHaveBeenCalledTimes(0);
      expect(nativeApiMock.loadBoardLanes).toHaveBeenCalledTimes(1);
      expect(nativeApiMock.loadBoardLanes).toHaveBeenCalledWith({ cwd: "/repo", limit: 50 });
      expect(nativeApiMock.listPullRequests).toHaveBeenCalledTimes(0);
      expect(naive.rows).toBe(pullRequests.length);
      expect(optimized.resultRows).toBe(REVIEW_BENCHMARK_INITIAL_LIMIT);
      expect(optimized.rows).toBeGreaterThan(0);
      expect(dataReadyReduction).toBeGreaterThanOrEqual(MIN_REVIEW_SURFACE_REDUCTION);
      expect(mountedRowReduction).toBeGreaterThanOrEqual(MIN_REVIEW_SURFACE_REDUCTION);
      expect(elapsedReduction).toBeGreaterThanOrEqual(MIN_REVIEW_SURFACE_REDUCTION);
      expect(document.body.textContent).toContain("Review benchmark PR 1");
      expect(document.body.textContent).not.toContain("Review benchmark PR 5000");
    } finally {
      await optimized.cleanup();
    }
  });
});
