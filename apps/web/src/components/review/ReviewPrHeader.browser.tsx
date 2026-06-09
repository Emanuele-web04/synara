import "../../index.css";

import type { ReviewPullRequestDetail } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ReviewPrHeader } from "./ReviewPrHeader";

const FAILING_PR = {
  number: 7866,
  title: "docs(test): dashboard vitest harness research",
  url: "https://github.com/enzo-health/bonaparte/pull/7866",
  state: "open",
  isDraft: false,
  author: "Tbsheff",
  baseBranch: "main",
  headBranch: "test-speed/06-harness-docs",
  body: "",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  additions: 251,
  deletions: 0,
  changedFiles: 2,
  commitsCount: 1,
  reviewDecision: null,
  mergeable: "MERGEABLE",
  checksStatus: "failing",
  milestone: null,
  labels: [],
  assignees: [],
  reviewers: [],
} satisfies ReviewPullRequestDetail;

describe("ReviewPrHeader", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps review changes available when checks are failing", async () => {
    const onReviewChanges = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ReviewPrHeader
        detail={FAILING_PR}
        variant="full"
        reviewMode="conversation"
        onReviewChanges={onReviewChanges}
      />,
      { container: host },
    );

    try {
      const button = page.getByRole("button", { name: "Review changes" });
      await expect.element(button).toBeEnabled();
      await button.click();
      expect(onReviewChanges).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders files mode with Devin-style breadcrumb, title, merge context, and overview action", async () => {
    await page.viewport(1280, 720);
    const onOverview = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ReviewPrHeader
        detail={{ ...FAILING_PR, checksStatus: "passing", mergeable: "MERGEABLE" }}
        variant="full"
        reviewMode="files"
        onOverview={onOverview}
        reviewAction={<button type="button">Submit review</button>}
      />,
      { container: host },
    );

    try {
      await expect.element(page.getByText("Pull Requests")).toBeVisible();
      await expect.element(page.getByText("enzo-health/bonaparte")).toBeVisible();
      await expect.element(page.getByText("#7866")).toBeVisible();
      await expect.element(page.getByRole("heading", { name: FAILING_PR.title })).toBeVisible();
      await expect.element(page.getByText("wants to merge into")).toBeVisible();
      await expect.element(page.getByText("main")).toBeVisible();
      await expect.element(page.getByText("test-speed/06-harness-docs")).toBeVisible();
      await expect.element(page.getByText("Ready to merge")).toBeVisible();

      const header = page.getByRole("banner").element();
      expect(header.getBoundingClientRect().height).toBeGreaterThanOrEqual(144);
      expect(header.getBoundingClientRect().height).toBeLessThanOrEqual(184);

      const overview = page.getByRole("button", { name: "Back to pull request overview" });
      await expect.element(overview).toBeVisible();
      await overview.click();
      expect(onOverview).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
