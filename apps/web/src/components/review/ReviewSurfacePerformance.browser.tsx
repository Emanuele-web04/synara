import "../../index.css";

import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewBoard } from "./ReviewBoard";

const navigateMock = vi.hoisted(() => vi.fn());
const nativeApiMock = vi.hoisted(() => ({
  getViewer: vi.fn(async () => ({ login: "tyler" })),
  listPullRequests: vi.fn(async () => ({ pullRequests: [] as ReviewPullRequestSummary[] })),
}));

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
    <section aria-label="Naive pull request board">
      <h2>Needs Review</h2>
      <ul>
        {props.pullRequests.map((pullRequest) => (
          <li key={pullRequest.number}>
            <button type="button">
              {pullRequest.title} #{pullRequest.number}
            </button>
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
  nativeApiMock.listPullRequests.mockResolvedValue({ pullRequests });
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
      const benchmark = {
        inputRows: pullRequests.length,
        naiveRows: naive.rows,
        optimizedRows: optimized.rows,
        mountedRowReduction,
        naiveElapsedMs: Math.round(naive.elapsedMs),
        optimizedElapsedMs: Math.round(optimized.elapsedMs),
        listCalls: nativeApiMock.listPullRequests.mock.calls.length,
        viewerCalls: nativeApiMock.getViewer.mock.calls.length,
      };
      console.info("[benchmark] review surface board", JSON.stringify(benchmark));

      expect(nativeApiMock.getViewer).toHaveBeenCalledTimes(0);
      expect(nativeApiMock.listPullRequests).toHaveBeenCalledTimes(1);
      expect(naive.rows).toBe(pullRequests.length);
      expect(optimized.rows).toBeGreaterThan(0);
      expect(mountedRowReduction).toBeGreaterThanOrEqual(10);
      expect(document.body.textContent).toContain("Review benchmark PR 1");
      expect(document.body.textContent).not.toContain("Review benchmark PR 5000");
    } finally {
      await optimized.cleanup();
    }
  });
});
