import "../../index.css";

import type { ReviewListPullRequestsResult, ReviewPullRequestSummary } from "@t3tools/contracts";
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
    title: `Review perf PR ${String(index + 1)}`,
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
    reviewRequests: index % 7 === 0 ? ["tyler"] : [],
    labels: [],
    assignees: [],
  }));
}

async function mountBoard(
  result: ReviewListPullRequestsResult | ReadonlyArray<ReviewPullRequestSummary>,
) {
  const listResult = Array.isArray(result) ? { pullRequests: result } : result;
  await page.viewport(1440, 900);
  nativeApiMock.getViewer.mockResolvedValue({ login: "tyler" });
  nativeApiMock.listPullRequests.mockResolvedValue(listResult);
  const host = document.createElement("div");
  host.className = "h-[900px] bg-background text-foreground";
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ReviewBoard cwd="/repo" />
    </QueryClientProvider>,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

describe("ReviewBoard performance", () => {
  afterEach(() => {
    nativeApiMock.getViewer.mockClear();
    nativeApiMock.listPullRequests.mockClear();
    navigateMock.mockClear();
    document.body.innerHTML = "";
  });

  it("keeps board DOM and list queries bounded for 1000 pull requests", async () => {
    const pullRequests = makePullRequests(1000);
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();
      await expect.element(page.getByText("Review perf PR 1", { exact: true })).toBeVisible();

      expect(nativeApiMock.listPullRequests).toHaveBeenCalledTimes(1);
      expect(nativeApiMock.listPullRequests).toHaveBeenCalledWith({ cwd: "/repo" });
      expect(document.querySelectorAll('[role="listitem"]').length).toBeLessThanOrEqual(
        Math.ceil(pullRequests.length / 10),
      );
      expect(document.body.textContent).not.toContain("Review perf PR 1000");
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes the needs-my-review view to the server without emptying local results", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 42,
        title: "Needs reviewer attention",
        reviewRequests: ["tyler"],
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();
      await page.getByRole("tab", { name: "Needs my review" }).click();
      await expect.element(page.getByText("Needs reviewer attention")).toBeVisible();

      expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
        cwd: "/repo",
        reviewRequested: "tyler",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("queries merged pull requests when the merged view is selected", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 88,
        title: "Merged review surface work",
        state: "merged",
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();
      await page.getByRole("tab", { name: "Merged" }).click();
      await expect.element(page.getByText("Merged review surface work")).toBeVisible();

      expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
        cwd: "/repo",
        state: "merged",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes status and check facets into the server list request", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 51,
        title: "Approved passing work",
        reviewDecision: "APPROVED",
        checksStatus: "passing",
      },
      {
        ...makePullRequests(1)[0],
        number: 52,
        title: "Pending review work",
        reviewDecision: null,
        checksStatus: "pending",
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Status", exact: true }).click();
      await page.getByRole("button", { name: "Approved", exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          columns: ["approved"],
        });
      });

      await page.getByRole("button", { name: "Checks", exact: true }).click();
      await page.getByRole("button", { name: "Passing", exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          columns: ["approved"],
          checks: ["passing"],
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes a single draft status facet into the server list request", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 55,
        title: "Draft review work",
        isDraft: true,
      },
      {
        ...makePullRequests(1)[0],
        number: 56,
        title: "Ready review work",
        isDraft: false,
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Status", exact: true }).click();
      await page.getByRole("button", { name: "Draft", exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          draft: true,
          columns: ["draft"],
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes a single base branch facet into the server list request", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 53,
        title: "Main branch work",
        baseBranch: "main",
      },
      {
        ...makePullRequests(1)[0],
        number: 54,
        title: "Release branch work",
        baseBranch: "release",
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Base", exact: true }).click();
      await page.getByRole("button", { name: "main", exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          baseBranch: "main",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes a single head branch facet into the server list request", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 55,
        title: "Review board branch work",
        headBranch: "feature/review-board",
        headSelector: "octocat:feature/review-board",
      },
      {
        ...makePullRequests(1)[0],
        number: 56,
        title: "Search branch work",
        headBranch: "bugfix/search",
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Head", exact: true }).click();
      await page.getByRole("button", { name: "octocat:feature/review-board", exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          headBranch: "octocat:feature/review-board",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes a single label facet into the server list request", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 57,
        title: "Bug labeled work",
        labels: ["bug"],
      },
      {
        ...makePullRequests(1)[0],
        number: 58,
        title: "Feature labeled work",
        labels: ["feature"],
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Label", exact: true }).click();
      await page.getByRole("button", { name: "bug", exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          label: "bug",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("pushes a single assignee facet into the server list request", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 59,
        title: "Assigned review work",
        assignees: ["alice"],
      },
      {
        ...makePullRequests(1)[0],
        number: 60,
        title: "Other assigned work",
        assignees: ["bob"],
      },
    ];
    const mounted = await mountBoard(pullRequests);

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Assignee", exact: true }).click();
      await page.getByRole("button", { name: "alice", exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          assignee: "alice",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks capped server-filtered counts as incomplete", async () => {
    const pullRequests = [
      {
        ...makePullRequests(1)[0],
        number: 61,
        title: "Approved capped work",
        reviewDecision: "APPROVED",
        checksStatus: "passing",
      },
    ];
    const mounted = await mountBoard({
      pullRequests,
      meta: {
        resultLimit: 50,
        candidateLimit: 1000,
        candidateCount: 1000,
        candidateLimitReached: true,
        matchedCount: 61,
        returnedCount: 1,
        bounded: true,
      },
    });

    try {
      await expect
        .element(page.getByRole("toolbar", { name: "Pull request review controls" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Status", exact: true }).click();
      await page.getByRole("button", { name: "Approved", exact: true }).click();

      await expect.element(page.getByText("1+ PRs", { exact: true })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });
});
