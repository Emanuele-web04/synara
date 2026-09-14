// FILE: EnvironmentPullRequestSection.browser.tsx
// Purpose: Browser regression tests for the PR row menu in the Environment panel — Repair
//          attaches composer context cards, the comment list scrolls, and link actions close
//          the panel.
// Layer: Vitest browser tests

import "../../../index.css";

import {
  ProjectId,
  ThreadId,
  type GitPullRequestSnapshotResult,
  type GitResolvedPullRequest,
  type GitStatusResult,
  type NativeApi,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { gitPullRequestSnapshotQueryOptions, gitQueryKeys } from "~/lib/gitReactQuery";
import { deferred } from "~/lib/pullRequestReactQuery.testUtils";
import { EnvironmentPullRequestSection } from "./EnvironmentPullRequestSection";

const { getGitStatus, getPullRequestSnapshot, getPullRequestDetail, runPullRequestAction } =
  vi.hoisted(() => ({
    getGitStatus: vi.fn<NativeApi["git"]["status"]>(),
    getPullRequestSnapshot: vi.fn<NativeApi["git"]["pullRequestSnapshot"]>(),
    getPullRequestDetail: vi.fn<NativeApi["pullRequests"]["detail"]>(),
    runPullRequestAction: vi.fn<NativeApi["pullRequests"]["action"]>(),
  }));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    git: { status: getGitStatus, pullRequestSnapshot: getPullRequestSnapshot },
    pullRequests: { detail: getPullRequestDetail, action: runPullRequestAction },
  }),
}));

const cwd = "/repo";
const threadId = ThreadId.makeUnsafe("thread-pr-fix-actions");
const queryClients = new Set<QueryClient>();
const pullRequest = {
  number: 321,
  title: "Keep PR context visible",
  url: "https://github.com/example/synara/pull/321",
  baseBranch: "main",
  headBranch: "fix/pr-panel",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 4,
  deletions: 2,
  changedFiles: 1,
} satisfies GitResolvedPullRequest;

// Seeds both cached queries so the component renders without calling the native API.
function createQueryClient(commentsOverride?: GitPullRequestSnapshotResult["comments"]) {
  const queryClient = new QueryClient();
  queryClients.add(queryClient);
  const gitStatus = {
    branch: pullRequest.headBranch,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    upstreamBranch: `origin/${pullRequest.headBranch}`,
    aheadCount: 0,
    behindCount: 0,
    pr: pullRequest,
  } satisfies GitStatusResult;
  const snapshot = {
    pullRequest,
    checks: [
      { name: "Test, lint, build, and smoke", status: "failure", url: "https://ci.example/1" },
      { name: "Typecheck", status: "success", url: null },
    ],
    comments: commentsOverride ?? [
      {
        id: "comment-1",
        author: "reviewer",
        body: "Preserve the Environment panel while drafting the fix.",
        path: "EnvironmentPullRequestSection.tsx",
        url: `${pullRequest.url}#discussion_r1`,
        createdAt: "2026-07-09T10:00:00Z",
      },
      {
        id: "comment-2",
        author: "reviewer",
        body: "Address the second review finding too.",
        path: "OtherFile.tsx",
        url: `${pullRequest.url}#discussion_r2`,
        createdAt: "2026-07-09T10:01:00Z",
      },
    ],
    commentsTruncated: false,
    commentsError: null,
  } satisfies GitPullRequestSnapshotResult;

  queryClient.setQueryData(gitQueryKeys.status(cwd), gitStatus);
  queryClient.setQueryData(
    gitPullRequestSnapshotQueryOptions({
      cwd,
      reference: pullRequest.url,
      enabled: true,
    }).queryKey,
    snapshot,
  );
  return queryClient;
}

function section(
  queryClient: QueryClient,
  onClose = vi.fn(),
  options: { enabled?: boolean; projectId?: ProjectId } = {},
) {
  return (
    <QueryClientProvider client={queryClient}>
      <EnvironmentPullRequestSection
        gitCwd={cwd}
        enabled={options.enabled ?? true}
        activeThreadId={threadId}
        // Link-only tests omit a project; status tests exercise the real mutation.
        projectId={options.projectId ?? null}
        configuredRepositories={[{ nameWithOwner: "example/synara" }]}
        onOpenUrl={vi.fn()}
        onClose={onClose}
      />
    </QueryClientProvider>
  );
}

function renderSection(queryClient: QueryClient, onClose = vi.fn()) {
  return render(section(queryClient, onClose));
}

async function openRepairSubmenu() {
  await page.getByText("#321 Keep PR context visible", { exact: true }).click();
  await expect.element(page.getByText("Repair", { exact: true })).toBeVisible();
  await page.getByText("Repair", { exact: true }).hover();
  await expect.element(page.getByText("Everything", { exact: true })).toBeVisible();
}

function draftCards() {
  return useComposerDraftStore.getState().draftsByThreadId[threadId]?.pullRequestContexts ?? [];
}

describe("EnvironmentPullRequestSection", () => {
  afterEach(async () => {
    await cleanup();
    for (const queryClient of queryClients) {
      queryClient.clear();
    }
    queryClients.clear();
    vi.resetAllMocks();
    useComposerDraftStore.getState().clearDraftThread(threadId);
  });

  it.each(["ready", "draft"] as const)(
    "shows %s immediately while GitHub is pending and restores the menu on failure",
    async (action) => {
      const queryClient = createQueryClient();
      const projectId = ProjectId.makeUnsafe("project-pr-status");
      const initialPr = { ...pullRequest, isDraft: action === "ready" };
      const statusKey = gitQueryKeys.status(cwd);
      const snapshotKey = gitPullRequestSnapshotQueryOptions({
        cwd,
        reference: pullRequest.url,
      }).queryKey;
      queryClient.setQueryData<GitStatusResult>(statusKey, (current) =>
        current ? { ...current, pr: initialPr } : current,
      );
      queryClient.setQueryData<GitPullRequestSnapshotResult>(snapshotKey, (current) =>
        current ? { ...current, pullRequest: initialPr } : current,
      );
      getGitStatus.mockResolvedValue(queryClient.getQueryData<GitStatusResult>(statusKey)!);
      getPullRequestSnapshot.mockResolvedValue(
        queryClient.getQueryData<GitPullRequestSnapshotResult>(snapshotKey)!,
      );
      // Status changes do not depend on the separate merge-capability read finishing.
      getPullRequestDetail.mockReturnValue(new Promise(() => {}));
      const request = deferred<Awaited<ReturnType<NativeApi["pullRequests"]["action"]>>>();
      runPullRequestAction.mockReturnValue(request.promise);
      await render(section(queryClient, vi.fn(), { projectId }));

      await page.getByText("#321 Keep PR context visible", { exact: true }).click();
      await page.getByRole("menuitem", { name: /^Status/ }).hover();
      const targetLabel = action === "ready" ? "Ready for review" : "Draft";
      const originalLabel = action === "ready" ? "Draft" : "Ready for review";
      await page.getByRole("menuitemradio", { name: targetLabel, exact: true }).click();

      await expect.poll(() => runPullRequestAction.mock.calls.length).toBe(1);
      expect(runPullRequestAction).toHaveBeenCalledWith({
        projectId,
        repository: "example/synara",
        number: 321,
        action,
      });
      await expect
        .element(page.getByRole("menuitem", { name: `Status ${targetLabel}`, exact: true }))
        .toBeVisible();

      request.reject(new Error("GitHub rejected the status change"));
      await expect
        .element(page.getByRole("menuitem", { name: `Status ${originalLabel}`, exact: true }))
        .toBeVisible();
    },
  );

  it("refreshes an old missing PR when the mounted panel opens", async () => {
    const queryClient = createQueryClient();
    const status = queryClient.getQueryData<GitStatusResult>(gitQueryKeys.status(cwd))!;
    getGitStatus.mockResolvedValue(status);
    const view = await render(section(queryClient, vi.fn(), { enabled: false }));
    queryClient.setQueryData(
      gitQueryKeys.status(cwd),
      { ...status, pr: null },
      { updatedAt: Date.now() - 60_000 },
    );
    await expect
      .element(page.getByText("#321 Keep PR context visible", { exact: true }))
      .not.toBeInTheDocument();

    await view.rerender(section(queryClient));

    await expect
      .element(page.getByText("#321 Keep PR context visible", { exact: true }))
      .toBeVisible();
    expect(getGitStatus).toHaveBeenCalledExactlyOnceWith({ cwd });
  });

  it.each(["merged", "closed"] as const)(
    "shows a branch's %s PR on first open without loading active PR details",
    async (state) => {
      const queryClient = createQueryClient();
      queryClient.setQueryData<GitStatusResult>(gitQueryKeys.status(cwd), (status) =>
        status ? { ...status, pr: { ...pullRequest, state } } : status,
      );
      queryClient.removeQueries({ queryKey: gitQueryKeys.pullRequest(cwd) });
      await renderSection(queryClient);

      const stateLabel = state === "merged" ? "Merged" : "Closed";
      const prRow = page.getByRole("button", {
        name: `#321 Keep PR context visible ${stateLabel}`,
      });
      await expect.element(prRow).toBeVisible();
      await expect
        .element(page.getByText(`${stateLabel} on GitHub`, { exact: true }))
        .toBeVisible();
      expect(queryClient.isFetching()).toBe(0);
      expect(getPullRequestSnapshot).not.toHaveBeenCalled();

      await prRow.click();
      await expect.element(page.getByText("View PR", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Code changes", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Add to chat", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Open in GitHub", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Repair", { exact: true })).not.toBeInTheDocument();
      await expect.element(page.getByText("Merge", { exact: true })).not.toBeInTheDocument();
    },
  );

  it("keeps the PR visible when git status settles after an open snapshot was cached", async () => {
    const queryClient = createQueryClient();
    await renderSection(queryClient);
    await expect
      .element(page.getByText("#321 Keep PR context visible", { exact: true }))
      .toBeVisible();

    queryClient.setQueryData<GitStatusResult>(gitQueryKeys.status(cwd), (status) =>
      status ? { ...status, pr: { ...pullRequest, state: "merged" } } : status,
    );

    await expect
      .element(page.getByText("#321 Keep PR context visible", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Merged on GitHub", { exact: true })).toBeVisible();
    await page.getByText("#321 Keep PR context visible", { exact: true }).click();
    await expect.element(page.getByText("Repair", { exact: true })).not.toBeInTheDocument();
  });

  it("attaches one Repair card per scope instead of pasting prompt text", async () => {
    const onClose = vi.fn();
    const queryClient = createQueryClient();
    await renderSection(queryClient, onClose);

    await openRepairSubmenu();
    // Repair's badge counts comments + failing checks + conflicts.
    expect(document.body.textContent).toContain("Repair");
    await page.getByText("Failing checks", { exact: true }).click();

    await expect.poll(() => draftCards().length).toBe(1);
    expect(draftCards()[0]).toMatchObject({
      scope: "checks",
      prNumber: 321,
      title: "1 failing check",
      subtitle: "Test, lint, build, and smoke",
    });
    expect(draftCards()[0]?.text).toContain("Fix the failing CI checks on PR #321");
    // The prompt itself never lands in the editor.
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "").toBe("");
    expect(onClose).toHaveBeenCalledTimes(1);

    // A second scope adds a second card; re-picking the same scope replaces, not stacks.
    await openRepairSubmenu();
    await page.getByText("Everything", { exact: true }).click();
    await expect.poll(() => draftCards().length).toBe(2);
    expect(draftCards()[1]).toMatchObject({
      scope: "everything",
      title: "Repair PR #321",
      subtitle: "2 comments, 1 failing check, merge conflicts",
    });
    expect(draftCards()[1]?.text).toContain(
      "Preserve the Environment panel while drafting the fix.",
    );
    expect(draftCards()[1]?.text).toContain("Address the second review finding too.");
    expect(draftCards()[1]?.text).toContain("Merge conflicts:");

    await openRepairSubmenu();
    await page.getByText("Failing checks", { exact: true }).click();
    await expect.poll(() => draftCards().length).toBe(2);
    expect(draftCards().filter((card) => card.scope === "checks")).toHaveLength(1);
  });

  it("adds the pull request itself to the chat as a reference card", async () => {
    const queryClient = createQueryClient();
    await renderSection(queryClient);

    await page.getByText("#321 Keep PR context visible", { exact: true }).click();
    await page.getByText("Add to chat", { exact: true }).click();

    await expect.poll(() => draftCards().length).toBe(1);
    expect(draftCards()[0]).toMatchObject({
      scope: "reference",
      title: "#321 Keep PR context visible",
      subtitle: "fix/pr-panel → main",
    });
  });

  it("scrolls long comment lists instead of crushing the rows", async () => {
    const comments = Array.from({ length: 6 }, (_, index) => ({
      id: `long-${index}`,
      author: "chatgpt-codex-connector",
      body: `**Finding ${index}: gateway compensation skips branch cleanup**\n\n<sub>Medium Severity</sub> <!-- DESCRIPTION START --> When a worktree creation partially fails, the compensation path returns before deleting the branch revision that was created, leaving orphaned refs behind. <!-- DESCRIPTION END -->`,
      path: "apps/server/src/agentGateway/creationCoordinator.ts",
      url: `${pullRequest.url}#discussion_r${index}`,
      createdAt: "2026-08-07T10:00:00Z",
    }));
    const queryClient = createQueryClient(comments);
    await renderSection(queryClient);

    await page.getByText("#321 Keep PR context visible", { exact: true }).click();
    await expect.element(page.getByText("6 comments", { exact: true })).toBeVisible();
    await page.getByText("Comments", { exact: true }).hover();
    await expect
      .poll(() => document.body.textContent?.includes("Finding 0"), { timeout: 5000 })
      .toBe(true);

    // Bot metadata markers are display noise and must never reach the popup.
    expect(document.body.textContent).not.toContain("DESCRIPTION START");

    // Reviewer avatar renders for each comment row.
    const avatars = document.querySelectorAll('img[src*="avatars.githubusercontent.com"]');
    expect(avatars.length).toBe(comments.length);

    // Every clamped title/snippet keeps at least one full line: when the list
    // overflows its max height, rows must scroll rather than flex-shrink into
    // slivers (their overflow-hidden spans have no automatic minimum size).
    const clamped = Array.from(document.querySelectorAll("span.line-clamp-2")).filter((span) =>
      span.textContent?.includes("Finding"),
    );
    expect(clamped.length).toBeGreaterThan(0);
    for (const span of clamped) {
      const lineHeight = Number.parseFloat(getComputedStyle(span).lineHeight);
      expect(span.getBoundingClientRect().height).toBeGreaterThanOrEqual(lineHeight - 0.5);
    }
  });
});
