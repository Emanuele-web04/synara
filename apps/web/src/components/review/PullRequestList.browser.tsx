import "../../index.css";

import type { ReviewListPullRequestsResult, ReviewPullRequestSummary } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PullRequestList } from "./PullRequestList";

const nativeApiMock = vi.hoisted(() => ({
  listPullRequests: vi.fn(async () => ({ pullRequests: [] as ReviewPullRequestSummary[] })),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    review: {
      listPullRequests: nativeApiMock.listPullRequests,
    },
  }),
}));

function pullRequest(input: {
  readonly number: number;
  readonly title: string;
  readonly labels: ReadonlyArray<string>;
}): ReviewPullRequestSummary {
  return {
    number: input.number,
    title: input.title,
    url: `https://github.com/acme/repo/pull/${String(input.number)}`,
    baseBranch: "main",
    headBranch: `branch-${String(input.number)}`,
    author: "alice",
    updatedAt: "2026-06-16T00:00:00.000Z",
    state: "open",
    reviewDecision: null,
    isDraft: false,
    additions: 1,
    deletions: 0,
    checksStatus: "pending",
    reviewRequests: [],
    labels: input.labels,
    assignees: [],
  };
}

async function mountList(
  result: ReviewListPullRequestsResult | ReadonlyArray<ReviewPullRequestSummary>,
) {
  const listResult = Array.isArray(result) ? { pullRequests: result } : result;
  nativeApiMock.listPullRequests.mockResolvedValue(listResult);
  const host = document.createElement("div");
  host.className = "h-[700px] bg-background text-foreground";
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <PullRequestList cwd="/repo" onSelectSource={vi.fn()} />
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

describe("PullRequestList filters", () => {
  afterEach(() => {
    nativeApiMock.listPullRequests.mockClear();
    document.body.innerHTML = "";
  });

  it("shows initial sync progress instead of an empty state while the first list request is pending", async () => {
    nativeApiMock.listPullRequests.mockImplementationOnce(
      () => new Promise<{ pullRequests: ReviewPullRequestSummary[] }>(() => undefined),
    );
    const mounted = await mountList([]);

    try {
      await expect.element(page.getByText("Syncing repository pull requests")).toBeVisible();
      expect(document.body.textContent).not.toContain("No open pull requests");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps cached label facet options available while composing server OR filters", async () => {
    const mounted = await mountList([
      pullRequest({ number: 57, title: "Bug labeled work", labels: ["bug"] }),
      pullRequest({ number: 58, title: "Feature labeled work", labels: ["feature"] }),
    ]);

    try {
      await expect.element(page.getByText("Bug labeled work")).toBeVisible();
      await expect.element(page.getByText("Feature labeled work")).toBeVisible();

      await page.getByRole("button", { name: "Label", exact: true }).click();
      await page.getByText("bug", { exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          label: "bug",
        });
      });

      await page.getByText("feature", { exact: true }).click();
      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          labels: ["bug", "feature"],
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("trusts server search results after the debounced query catches up", async () => {
    const mounted = await mountList([
      pullRequest({
        number: 90,
        title: "Initial unfiltered pull request",
        labels: [],
      }),
    ]);

    try {
      await expect.element(page.getByText("Initial unfiltered pull request")).toBeVisible();
      nativeApiMock.listPullRequests.mockResolvedValueOnce({
        pullRequests: [
          pullRequest({
            number: 91,
            title: "Returned by GitHub body search",
            labels: [],
          }),
        ],
      });
      await page.getByPlaceholder("Search PRs, #7870, or a GitHub URL").fill("body-only-match");

      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          search: "body-only-match",
        });
      });
      expect(nativeApiMock.listPullRequests.mock.calls).toEqual([
        [{ cwd: "/repo" }],
        [{ cwd: "/repo", search: "body-only-match" }],
      ]);
      await expect.element(page.getByText("Returned by GitHub body search")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("loads a larger review window when the list scrolls near the bottom", async () => {
    let resolveNextWindow:
      | ((value: ReviewListPullRequestsResult) => void)
      | null = null;
    const mounted = await mountList({
      pullRequests: Array.from({ length: 50 }, (_, index) =>
        pullRequest({
          number: index + 1,
          title: `Scrollable PR ${String(index + 1)}`,
          labels: [],
        }),
      ),
      meta: {
        resultLimit: 50,
        candidateLimit: 50,
        candidateCount: 50,
        candidateLimitReached: true,
        matchedCount: 50,
        returnedCount: 50,
        bounded: true,
      },
    });

    try {
      await expect.element(page.getByText("Scrollable PR 1", { exact: true })).toBeVisible();
      nativeApiMock.listPullRequests.mockImplementationOnce(
        () =>
          new Promise<ReviewListPullRequestsResult>((resolve) => {
            resolveNextWindow = resolve;
          }),
      );

      const list = document.querySelector<HTMLElement>('[role="list"]');
      expect(list).not.toBeNull();
      list!.scrollTop = list!.scrollHeight - list!.clientHeight;
      list!.dispatchEvent(new Event("scroll", { bubbles: true }));

      await vi.waitFor(() => {
        expect(nativeApiMock.listPullRequests).toHaveBeenLastCalledWith({
          cwd: "/repo",
          limit: 100,
        });
      });
      await expect.element(page.getByText("Scrollable PR 1", { exact: true })).toBeVisible();

      resolveNextWindow?.({
        pullRequests: Array.from({ length: 100 }, (_, index) =>
          pullRequest({
            number: index + 1,
            title: `Scrollable PR ${String(index + 1)}`,
            labels: [],
          }),
        ),
        meta: {
          requestedLimit: 100,
          resultLimit: 100,
          candidateLimit: 100,
          candidateCount: 100,
          candidateLimitReached: false,
          matchedCount: 100,
          returnedCount: 100,
          bounded: true,
        },
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
