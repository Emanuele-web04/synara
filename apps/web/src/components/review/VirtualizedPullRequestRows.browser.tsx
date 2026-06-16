import "../../index.css";

import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { VirtualizedPullRequestRows } from "./VirtualizedPullRequestRows";

function makePullRequests(count: number): ReviewPullRequestSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `PR ${String(index + 1)}`,
    url: `https://github.com/acme/repo/pull/${String(index + 1)}`,
    baseBranch: "main",
    headBranch: `branch-${String(index + 1)}`,
    author: "tyler",
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

async function renderRows(props: {
  pullRequests: ReadonlyArray<ReviewPullRequestSummary>;
  threshold: number;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <VirtualizedPullRequestRows
      pullRequests={props.pullRequests}
      estimateSize={40}
      overscan={1}
      threshold={props.threshold}
      className="h-[160px] w-[320px]"
      rowClassName="h-[40px]"
      renderPullRequest={(pullRequest) => (
        <button type="button">Open PR {pullRequest.number}</button>
      )}
    />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("VirtualizedPullRequestRows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps constrained lists scrollable below the virtualization threshold", async () => {
    const pullRequests = makePullRequests(20);
    const mounted = await renderRows({ pullRequests, threshold: 30 });

    try {
      const list = page.getByRole("list").element();
      await expect.element(page.getByRole("button", { name: "Open PR 20" })).toBeVisible();

      expect(getComputedStyle(list).overflowY).toBe("auto");
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      expect(document.querySelectorAll("li")).toHaveLength(pullRequests.length);
      expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps mounted rows at least 10x smaller than a large pull request list", async () => {
    const pullRequests = makePullRequests(1000);
    const mounted = await renderRows({ pullRequests, threshold: 10 });

    try {
      await expect.element(page.getByRole("list")).toBeVisible();

      const rows = document.querySelectorAll('[role="listitem"]');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(pullRequests.length / 10);
      expect(document.body.textContent).toContain("Open PR 1");
      expect(document.body.textContent).not.toContain("Open PR 1000");
    } finally {
      await mounted.cleanup();
    }
  });
});
