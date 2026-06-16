import "../../index.css";

import type { ReviewPullRequestSummary } from "@t3tools/contracts";
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

async function mountList(pullRequests: ReadonlyArray<ReviewPullRequestSummary>) {
  nativeApiMock.listPullRequests.mockResolvedValue({ pullRequests });
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

      await page.getByRole("button", { name: /Label/ }).click();
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
});
