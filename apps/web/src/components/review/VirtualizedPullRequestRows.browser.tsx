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

  it("does not leave a blank spacer above rows after scrolling back up", async () => {
    const pullRequests = makePullRequests(80);
    const mounted = await renderRows({ pullRequests, threshold: 10 });

    try {
      const list = page.getByRole("list").element();
      await expect.element(page.getByRole("button", { name: "Open PR 1" })).toBeVisible();

      list.scrollTop = 800;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await expect.poll(() => list.scrollTop).toBeGreaterThan(0);

      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await expect.element(page.getByRole("button", { name: "Open PR 1" })).toBeVisible();

      const firstRow = document.querySelector<HTMLElement>('[role="listitem"]');
      expect(firstRow).not.toBeNull();
      const listTop = list.getBoundingClientRect().top;
      expect(firstRow!.getBoundingClientRect().top - listTop).toBeLessThanOrEqual(4);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps rows pinned to the viewport after partial upward scrolling", async () => {
    const pullRequests = makePullRequests(80);
    const mounted = await renderRows({ pullRequests, threshold: 10 });

    try {
      const list = page.getByRole("list").element();
      await expect.element(page.getByRole("button", { name: "Open PR 1" })).toBeVisible();

      list.scrollTop = 1_600;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await expect.poll(() => list.scrollTop).toBeGreaterThan(1_000);

      list.scrollTop = 1_000;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
      await expect.poll(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="listitem"]'));
        const listTop = list.getBoundingClientRect().top;
        return rows.some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > listTop && rect.top <= listTop + 4;
        });
      }).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });
});
