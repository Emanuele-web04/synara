import "../../index.css";

import type {
  ReviewChangedFile,
  ReviewCheck,
  ReviewConversationResult,
  ReviewPullRequestDetail,
  ReviewSourceRef,
  ReviewTargetKey,
} from "@t3tools/contracts";
import { serializeReviewTargetKey } from "@t3tools/shared/reviewTargetKey";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { reviewQueryKeys } from "~/lib/reviewReactQuery";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
import { ReviewPrView } from "./ReviewPrView";

const CWD = "/Users/tylersheffield/code/bonaparte";
const REFERENCE = "7866";
const SOURCE = { _tag: "pullRequest", reference: REFERENCE } satisfies ReviewSourceRef;
const TARGET = {
  _tag: "pullRequest",
  repositoryId: "github:enzo-health/bonaparte",
  number: 7866,
} satisfies ReviewTargetKey;

const DETAIL = {
  number: 7866,
  title: "docs(test): dashboard vitest harness research",
  url: "https://github.com/enzo-health/bonaparte/pull/7866",
  state: "open",
  isDraft: false,
  author: "Tbsheff",
  authorAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  baseBranch: "main",
  headBranch: "test-speed/06-harness-docs",
  body: Array.from(
    { length: 48 },
    (_, index) =>
      `Review note ${index + 1}: Make the local dashboard Vitest loop fast enough to run routinely while preserving the changed-files and checks context.`,
  ).join("\n\n"),
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  additions: 251,
  deletions: 0,
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

const CHECKS = [
  { name: "build_validation", state: "success", workflow: "CI" },
  { name: "porter-config", state: "success", workflow: "CI" },
  { name: "consumer_validation", state: "success", workflow: "CI" },
  { name: "e2e-tests", state: "success", workflow: "CI" },
] satisfies ReadonlyArray<ReviewCheck>;

const FILES = [
  {
    path: "docs/design-docs/dashboard-vitest-harness-research.md",
    insertions: 245,
    deletions: 0,
  },
  { path: "docs/design-docs/index.md", insertions: 6, deletions: 0 },
] satisfies ReadonlyArray<ReviewChangedFile>;

const PATCH = `diff --git a/docs/design-docs/dashboard-vitest-harness-research.md b/docs/design-docs/dashboard-vitest-harness-research.md
index 1111111..2222222 100644
--- a/docs/design-docs/dashboard-vitest-harness-research.md
+++ b/docs/design-docs/dashboard-vitest-harness-research.md
@@ -1,5 +1,16 @@
 # Dashboard Vitest Harness Research
 
+## Current Findings
+
+The current performance cliff is DB harness startup and coordination, not individual assertions.
+
+\`\`\`text
+test:all
+  -> unit lane: 1,417 files
+  -> db lane: 992 files
+  -> shard N starts Vitest
+\`\`\`
+
 The local dashboard Vitest loop should be fast enough to run routinely.
 
 ## Official Vitest Guidance
diff --git a/docs/design-docs/index.md b/docs/design-docs/index.md
index 3333333..4444444 100644
--- a/docs/design-docs/index.md
+++ b/docs/design-docs/index.md
@@ -1,4 +1,10 @@
 # Design Documents
 
 | Document | Description |
 | --- | --- |
+| [Dashboard Vitest Harness Research](dashboard-vitest-harness-research.md) | Investigation into dashboard test speed. |
+| [Review Surface](review-surface.md) | Pull request review interaction model. |
+| [Agent Review](agent-review.md) | Agent-assisted review behavior. |
+| [Diff Navigation](diff-navigation.md) | Files rail and inline comment navigation. |
+| [Checks Summary](checks-summary.md) | CI checks and readiness presentation. |
+| [Sidebar Context](sidebar-context.md) | Ask Devin context model. |
`;

function createClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(reviewQueryKeys.pullRequest(CWD, REFERENCE), {
    detail: DETAIL,
    commits: [],
    checks: CHECKS,
  });
  queryClient.setQueryData(reviewQueryKeys.conversation(CWD, REFERENCE), {
    events: [
      {
        _tag: "commit",
        oid: "2162c93b6d8f",
        abbreviatedOid: "2162c93",
        messageHeadline: "docs(test): add dashboard vitest harness research + index entry",
        author: "Tbsheff",
        createdAt: "2026-06-07T00:00:00.000Z",
      },
    ],
  } satisfies ReviewConversationResult);
  queryClient.setQueryData(reviewQueryKeys.changeset(CWD, `pullRequest:${REFERENCE}`), {
    target: TARGET,
    patch: PATCH,
    files: FILES,
    headSha: "2162c93b6d8f",
  });
  queryClient.setQueryData(reviewQueryKeys.comments(serializeReviewTargetKey(TARGET)), {
    target: TARGET,
    comments: [],
  });
  queryClient.setQueryData(reviewQueryKeys.remoteThreads(CWD, REFERENCE), {
    threads: [],
  });
  return queryClient;
}

async function mountReviewPrView(
  viewport: { width: number; height: number } = { width: 2048, height: 1280 },
  themeMode: "light" | "dark" = "dark",
) {
  await page.viewport(viewport.width, viewport.height);
  window.localStorage.clear();
  window.localStorage.setItem(
    "synara:theme",
    serializeThemeState({ ...DEFAULT_THEME_STATE, mode: themeMode }),
  );
  document.documentElement.classList.toggle("dark", themeMode === "dark");
  const host = document.createElement("div");
  host.style.width = `${viewport.width}px`;
  host.style.height = `${viewport.height}px`;
  host.className = "overflow-hidden bg-background text-foreground";
  document.body.append(host);
  const queryClient = createClient();
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <div className="flex h-full min-h-0 min-w-0">
        <ReviewPrView cwd={CWD} reference={REFERENCE} source={SOURCE} />
      </div>
    </QueryClientProvider>,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      queryClient.clear();
      host.remove();
      document.documentElement.classList.remove("dark");
      window.localStorage.clear();
    },
  };
}

function colorChannelValues(color: string): [number, number, number] {
  const rgbMatch = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  if (rgbMatch) {
    return [Number(rgbMatch[1]) / 255, Number(rgbMatch[2]) / 255, Number(rgbMatch[3]) / 255];
  }
  const srgbMatch = /color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/.exec(color);
  if (srgbMatch) {
    return [Number(srgbMatch[1]), Number(srgbMatch[2]), Number(srgbMatch[3])];
  }
  throw new Error(`Unsupported color format: ${color}`);
}

function approximateLuminance(color: string): number {
  const [red, green, blue] = colorChannelValues(color);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

describe("ReviewPrView visual composition", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("style");
    window.localStorage.clear();
  });

  it("composes the populated files workspace without overflow or dead-end navigation", async () => {
    const mounted = await mountReviewPrView();

    try {
      await expect.element(page.getByRole("heading", { name: "Ask Devin" })).toBeVisible();
      expect(document.querySelector('[aria-label="Ask about this pull request"]')).toBeTruthy();
      await page.getByRole("tab", { name: "Info" }).click();
      expect(document.body.textContent).toContain("build_validation");
      await page.getByRole("tab", { name: "Chat" }).click();
      await expect.element(page.getByRole("button", { name: "Summarize this PR" })).toBeVisible();
      const chatInput = page.getByTestId("composer-editor");
      await chatInput.fill("Keep this draft across review modes");
      await expect.element(page.getByText("Pull Requests")).toBeVisible();
      await expect.element(page.getByText("enzo-health/bonaparte")).toBeVisible();
      await expect.element(page.getByRole("heading", { name: DETAIL.title })).toBeVisible();
      expect(document.body.textContent).toContain("wants to merge into");
      const overviewTitle = page.getByRole("heading", { name: DETAIL.title }).element();
      const overviewScroller = overviewTitle.closest("main");
      expect(overviewScroller).toBeTruthy();
      expect(overviewScroller!.scrollHeight).toBeGreaterThan(overviewScroller!.clientHeight);
      const overviewTitleTop = overviewTitle.getBoundingClientRect().top;
      overviewScroller!.scrollTop = 220;
      await expect
        .poll(() => overviewTitle.getBoundingClientRect().top)
        .toBeLessThan(overviewTitleTop - 80);
      overviewScroller!.scrollTop = 0;
      await page.getByRole("button", { name: "Review changes" }).click();
      await expect.element(page.getByText("Keep this draft across review modes")).toBeVisible();
      await expect.element(page.getByText("Current Findings")).toBeVisible();
      await expect.element(page.getByRole("tab", { name: "Info" })).toBeVisible();
      await expect.element(page.getByRole("tab", { name: "Chat" })).toBeVisible();
      const desktopFileSelect = document.querySelector<HTMLElement>(
        'select[aria-label="Jump to changed file"]',
      );
      expect(desktopFileSelect).toBeTruthy();
      await expect
        .element(page.getByRole("button", { name: "Back to pull request overview" }))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("wants to merge into");
      await expect.element(page.getByRole("button", { name: "Run agent review" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Submit review" })).toBeVisible();
      await page.getByRole("tab", { name: "Info" }).click();
      await expect.element(page.getByText("build_validation")).toBeVisible();
      await expect.element(page.getByText("porter-config")).toBeVisible();

      const host = document.body.firstElementChild;
      expect(host).toBeTruthy();
      expect(host?.scrollWidth).toBeLessThanOrEqual(host?.clientWidth ?? 0);

      const filesHeading = page.getByRole("heading", { name: "Files" }).element();
      const diffViewport = document.querySelector(".review-diff-viewport");
      const fileRail = filesHeading.closest("aside");
      const fileRailWidth = fileRail?.getBoundingClientRect().width ?? 0;
      const diffHeight = diffViewport?.getBoundingClientRect().height ?? 0;
      const workbench = document.querySelector<HTMLElement>(".review-files-workbench");
      expect(workbench).toBeTruthy();
      expect(workbench!.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
        (host?.getBoundingClientRect().bottom ?? 0) - 1,
      );
      expect(approximateLuminance(getComputedStyle(workbench!).backgroundColor)).toBeLessThan(0.16);
      expect(
        approximateLuminance(diffViewport ? getComputedStyle(diffViewport).backgroundColor : ""),
      ).toBeLessThan(0.18);
      expect(
        approximateLuminance(fileRail ? getComputedStyle(fileRail).backgroundColor : ""),
      ).toBeLessThan(0.18);
      const workbenchHeight = workbench?.getBoundingClientRect().height ?? 0;

      expect(fileRailWidth).toBeGreaterThanOrEqual(270);
      expect(fileRailWidth).toBeLessThanOrEqual(274);
      expect(diffHeight).toBeGreaterThan(560);
      expect(workbenchHeight).toBeGreaterThanOrEqual(diffHeight);

      const fileResizeHandle = page.getByRole("separator", { name: "Resize file list" });
      const fileResizeElement = fileResizeHandle.element();
      fileResizeElement.focus();
      fileResizeElement.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
      await vi.waitFor(() => {
        expect(fileRail?.getBoundingClientRect().width ?? 0).toBeGreaterThan(fileRailWidth);
      });

      await page.getByRole("button", { name: "Collapse file tree" }).click();
      await expect.element(page.getByRole("button", { name: "Expand file tree" })).toBeVisible();
      expect(
        page.getByRole("button", { name: "Expand file tree" }).element().closest("aside"),
      ).toBeTruthy();
      expect(
        page
          .getByRole("button", { name: "Expand file tree" })
          .element()
          .closest("aside")!
          .getBoundingClientRect().width,
      ).toBeLessThanOrEqual(52);

      await page.getByRole("button", { name: "Expand file tree" }).click();
      await expect.element(page.getByRole("button", { name: "Collapse file tree" })).toBeVisible();

      await page.getByRole("treeitem", { name: /dashboard-vitest-harness-research\.md/ }).click();
      await expect
        .element(page.getByRole("button", { name: /Back to pull request overview/ }))
        .toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the Ask Devin rail visible at normal desktop widths", async () => {
    const mounted = await mountReviewPrView({ width: 1440, height: 960 });

    try {
      await expect.element(page.getByRole("heading", { name: "Ask Devin" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Summarize this PR" })).toBeVisible();
      await page.getByRole("button", { name: "Review changes" }).click();
      await expect.element(page.getByText("Current Findings")).toBeVisible();
      await page.getByRole("tab", { name: "Chat" }).click();
      await expect.element(page.getByRole("heading", { name: "Ask Devin" })).toBeVisible();
      expect(document.querySelector('[aria-label="Ask about this pull request"]')).toBeTruthy();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses semantic light surfaces instead of forcing the files workspace dark", async () => {
    const mounted = await mountReviewPrView({ width: 1440, height: 960 }, "light");

    try {
      await page.getByRole("button", { name: "Review changes" }).click();
      await expect.element(page.getByText("Current Findings")).toBeVisible();
      const workbench = document.querySelector<HTMLElement>(".review-files-workbench");
      const diffViewport = document.querySelector<HTMLElement>(".review-diff-viewport");
      expect(workbench).toBeTruthy();
      expect(diffViewport).toBeTruthy();
      expect(approximateLuminance(getComputedStyle(workbench!).backgroundColor)).toBeGreaterThan(
        0.72,
      );
      expect(approximateLuminance(getComputedStyle(diffViewport!).backgroundColor)).toBeGreaterThan(
        0.68,
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
