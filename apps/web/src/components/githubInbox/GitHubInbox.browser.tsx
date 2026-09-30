// FILE: GitHubInbox.browser.tsx
// Purpose: Browser coverage for the GitHub inbox page body: filter combinations (kind, several
//          projects, involvement, labels), persistence across remount and URL overrides,
//          selection and deep links, the loading / empty / unavailable / rate-limited states,
//          and focus returning to the row after the narrow layout's back control.
// Layer: GitHub inbox test

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type GitHubInboxItem,
  type GitHubInboxListResult,
  type GitHubIssueDetail,
  type NativeApi,
  type ProjectId,
  type PullRequestActor,
  type PullRequestDetail,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "~/store";
import type { Project } from "~/types";

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));

import { GitHubInbox } from "./GitHubInbox";
import { mergeGitHubInboxSearch, type GitHubInboxSearch } from "./githubInbox.logic";

const projectA = "project-a" as ProjectId;
const projectB = "project-b" as ProjectId;
const NOW = "2026-09-29T08:00:00.000Z";

function actor(login: string): PullRequestActor {
  return { login, name: null, avatarUrl: null, url: null };
}

function project(id: ProjectId, name: string): Project {
  return {
    id,
    kind: "project",
    name,
    remoteName: name,
    folderName: name.toLowerCase(),
    localName: null,
    cwd: `/work/${name.toLowerCase()}`,
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
  } as Project;
}

function context(projectId: ProjectId) {
  return [{ projectId, projectTitle: projectId === projectA ? "Alpha" : "Beta", isPinned: false }];
}

const PULL_REQUEST_41: GitHubInboxItem = {
  kind: "pullRequest",
  projectId: projectA,
  projectTitle: "Alpha",
  projectContexts: context(projectA),
  repository: "acme/widgets",
  number: 41,
  title: "Fix login redirect",
  url: "https://github.com/acme/widgets/pull/41",
  author: actor("teammate"),
  headBranch: "fix/login",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  additions: 12,
  deletions: 3,
  createdAt: NOW,
  updatedAt: NOW,
  reviewDecision: null,
  viewerReviewRequested: true,
  isPinned: false,
  mergeability: "mergeable",
  stack: null,
  labels: [{ name: "kind:bug", color: "d73a4a" }],
  commentCount: 0,
  assignees: [],
  viewerInvolvement: { authored: false, assigned: false, involved: false },
};

const ISSUE_42: GitHubInboxItem = {
  kind: "issue",
  projectId: projectA,
  projectTitle: "Alpha",
  projectContexts: context(projectA),
  repository: "acme/widgets",
  number: 42,
  title: "Crash on launch",
  url: "https://github.com/acme/widgets/issues/42",
  author: actor("reporter"),
  state: "open",
  stateReason: null,
  labels: [
    { name: "kind:bug", color: "d73a4a" },
    { name: "area:ui", color: "0e8a16" },
  ],
  assignees: [actor("viewer")],
  commentCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
  isPinned: false,
  viewerInvolvement: { authored: false, assigned: true, involved: true },
};

const ISSUE_43: GitHubInboxItem = {
  ...ISSUE_42,
  projectId: projectB,
  projectTitle: "Beta",
  projectContexts: context(projectB),
  repository: "acme/gadgets",
  number: 43,
  title: "Docs typo",
  url: "https://github.com/acme/gadgets/issues/43",
  labels: [{ name: "docs", color: null }],
  assignees: [],
  commentCount: 0,
  viewerInvolvement: { authored: false, assigned: false, involved: false },
};

const PULL_REQUEST_44: GitHubInboxItem = {
  ...PULL_REQUEST_41,
  projectId: projectB,
  projectTitle: "Beta",
  projectContexts: context(projectB),
  repository: "acme/gadgets",
  number: 44,
  title: "Add gadget export",
  url: "https://github.com/acme/gadgets/pull/44",
  author: actor("viewer"),
  viewerReviewRequested: false,
  labels: [],
  viewerInvolvement: { authored: true, assigned: false, involved: true },
};

function listResult(overrides: Partial<GitHubInboxListResult> = {}): GitHubInboxListResult {
  return {
    viewer: "viewer",
    items: [PULL_REQUEST_41, ISSUE_42, ISSUE_43, PULL_REQUEST_44],
    errors: [],
    repositoryBatches: [],
    rateLimit: null,
    reviewRequestedCount: 1,
    reviewRequestedCountIncomplete: false,
    ...overrides,
  };
}

const ISSUE_42_DETAIL: GitHubIssueDetail = {
  projectId: projectA,
  projectTitle: "Alpha",
  workspaceRoot: "/work/alpha",
  repository: "acme/widgets",
  number: 42,
  title: "Crash on launch",
  url: "https://github.com/acme/widgets/issues/42",
  author: actor("reporter"),
  state: "open",
  stateReason: null,
  labels: ISSUE_42.labels,
  assignees: [actor("viewer")],
  commentCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
  body: "The app quits right after the splash screen.",
  comments: [
    {
      id: "comment-1",
      kind: "issue-comment",
      author: actor("teammate"),
      body: "Reproduced on the beta build.",
      createdAt: NOW,
      updatedAt: null,
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  commentsTruncated: false,
};

const PULL_REQUEST_41_DETAIL: PullRequestDetail = {
  projectId: projectA,
  projectTitle: "Alpha",
  workspaceRoot: "/work/alpha",
  repository: "acme/widgets",
  number: 41,
  title: "Fix login redirect",
  body: "Sends people back where they came from.",
  url: "https://github.com/acme/widgets/pull/41",
  author: actor("teammate"),
  state: "open",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeability: "mergeable",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  headBranch: "fix/login",
  baseBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  closedAt: null,
  maintainerCanModify: true,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentsTruncated: false,
  commentsIncomplete: false,
  commits: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true, deleteBranchOnMerge: false },
  stack: null,
  stackMetadataIncomplete: false,
};

const api = {
  list: vi.fn<(input: { state: "open" | "closed" }) => Promise<GitHubInboxListResult>>(),
  issueDetail: vi.fn(),
  pullRequestDetail: vi.fn(),
  openExternal: vi.fn(),
};

function installNativeApi() {
  window.nativeApi = {
    githubInbox: {
      list: api.list,
      issueDetail: api.issueDetail,
      issueComment: vi.fn(),
    },
    pullRequests: {
      detail: api.pullRequestDetail,
      setPinned: vi.fn(),
      comment: vi.fn(),
      action: vi.fn(),
      diff: vi.fn(),
    },
    server: {
      getSettings: () => Promise.resolve(DEFAULT_SERVER_SETTINGS_VIEW),
      updateSettings: () => Promise.resolve(DEFAULT_SERVER_SETTINGS_VIEW),
    },
    shell: { openExternal: api.openExternal },
  } as unknown as NativeApi;
}

let latestSearch: GitHubInboxSearch = {};

function Harness({ initialSearch }: { initialSearch: GitHubInboxSearch }) {
  const [search, setSearch] = useState(initialSearch);
  latestSearch = search;
  return (
    <GitHubInbox
      search={search}
      onSearchChange={(patch) => setSearch((previous) => mergeGitHubInboxSearch(previous, patch))}
    />
  );
}

function mount(initialSearch: GitHubInboxSearch = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness initialSearch={initialSearch} />
    </QueryClientProvider>,
  );
}

function visibleRowNumbers(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>("button[data-pull-request-row]")).map(
    (row) => Number(row.dataset.pullRequestNumber),
  );
}

async function expectRows(numbers: number[]) {
  await expect.poll(visibleRowNumbers).toEqual(numbers);
}

async function closeMenu() {
  // An open submenu takes its own Escape before the menu's.
  await expect
    .poll(async () => {
      if (document.querySelector('[role="menu"]')) await userEvent.keyboard("{Escape}");
      return document.querySelector('[role="menu"]');
    })
    .toBeNull();
}

beforeEach(async () => {
  localStorage.clear();
  latestSearch = {};
  api.list
    .mockReset()
    .mockImplementation(({ state }) =>
      Promise.resolve(state === "open" ? listResult() : listResult({ items: [] })),
    );
  api.issueDetail.mockReset().mockResolvedValue(ISSUE_42_DETAIL);
  api.pullRequestDetail.mockReset().mockResolvedValue(PULL_REQUEST_41_DETAIL);
  api.openExternal.mockReset().mockResolvedValue(undefined);
  installNativeApi();
  useStore.setState({ projects: [project(projectA, "Alpha"), project(projectB, "Beta")] });
  await page.viewport(1280, 800);
});

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as { nativeApi?: NativeApi }).nativeApi;
  useStore.setState({ projects: [] });
});

describe("GitHubInbox list", () => {
  it("lists pull requests and issues in one flat list", async () => {
    await mount();

    await expectRows([44, 43, 42, 41]);
    const groupHeaders = Array.from(document.querySelectorAll("h2")).map(
      (node) => node.textContent,
    );
    // No pinned rows, so no group headers at all.
    expect(groupHeaders).toEqual([]);
    await expect.element(page.getByRole("img", { name: "Issue open" }).first()).toBeVisible();
    await expect.element(page.getByText("Nothing selected")).toBeVisible();
    expect(api.list).toHaveBeenCalledWith({ state: "open" });
  });

  it("combines kind, project, involvement, and label filters, then clears them", async () => {
    await mount();
    await expectRows([44, 43, 42, 41]);
    // Each kind segment counts what it would show under the other filters.
    await expect.element(page.getByRole("radio", { name: "All, 4" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Pull requests, 2" })).toBeVisible();
    // No filter is away from its default, so no chips and nothing to clear.
    expect(document.querySelector('[aria-label="Active filters"]')).toBeNull();

    await page.getByRole("radio", { name: "Issues, 2" }).click();
    await expectRows([43, 42]);

    // One Filter menu holds every filter; projects and labels are submenus.
    await page.getByRole("button", { name: /^Filter/ }).click();
    await expect.element(page.getByText("Status", { exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: /^Projects/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "Beta" }).click();
    await expectRows([43]);
    await expect.element(page.getByRole("radio", { name: "Pull requests, 1" })).toBeVisible();
    await page.getByRole("menuitemcheckbox", { name: "Alpha" }).click();
    await expectRows([43, 42]);
    await closeMenu();
    // Each active filter is a removable chip; two projects in view means rows name theirs.
    await expect.element(page.getByRole("button", { name: "Remove filter: Alpha" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove filter: Beta" })).toBeVisible();
    expect(document.querySelector('[data-pull-request-number="43"]')?.textContent).toContain(
      "Beta",
    );

    await page.getByRole("button", { name: /^Filter/ }).click();
    await page.getByRole("menuitemradio", { name: "Assigned to me" }).click();
    await expectRows([42]);
    await closeMenu();
    await expect.element(page.getByRole("button", { name: "Filter (2 active)" })).toBeVisible();

    // A chip removes just its own filter.
    await page.getByRole("button", { name: "Remove filter: Assigned to me" }).click();
    await expectRows([43, 42]);
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expectRows([44, 43, 42, 41]);

    await page.getByRole("button", { name: /^Filter/ }).click();
    await page.getByRole("menuitem", { name: /^Labels/ }).click();
    await page.getByRole("menuitemcheckbox", { name: /kind:bug/ }).click();
    await expectRows([42, 41]);
    await closeMenu();

    await page.getByRole("radio", { name: /^Pull requests/ }).click();
    await expectRows([41]);
    await page
      .getByRole("textbox", { name: "Search pull requests and issues" })
      .fill("nothing matches");
    await expect.element(page.getByText("No pull requests found")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expectRows([44, 43, 42, 41]);
    expect(latestSearch.q).toBeUndefined();
  });

  it("keeps filters across a remount, while a URL override wins for one visit", async () => {
    const first = await mount();
    await expectRows([44, 43, 42, 41]);
    await page.getByRole("radio", { name: /^Issues/ }).click();
    await expectRows([43, 42]);
    await first.unmount();

    const second = await mount();
    await expectRows([43, 42]);
    await expect.element(page.getByRole("radio", { name: /^Issues/ })).toBeChecked();
    await second.unmount();

    // The sidebar's per-project button: one project for this visit, saved filters untouched.
    await mount({ type: "pullRequest", projectId: projectB });
    await expectRows([44]);
    await expect.element(page.getByRole("button", { name: "Remove filter: Beta" })).toBeVisible();
    const saved = JSON.parse(localStorage.getItem("synara:app-settings:v1") ?? "{}");
    expect(saved.githubInboxKind).toBe("issue");
    expect(saved.githubInboxProjectIds ?? []).toEqual([]);
  });

  it("switches the list to the closed state, which its chip undoes", async () => {
    await mount();
    await expectRows([44, 43, 42, 41]);
    await page.getByRole("button", { name: /^Filter/ }).click();
    await page.getByRole("menuitemradio", { name: "Closed" }).click();
    await expect.element(page.getByText("No pull requests and issues found")).toBeVisible();
    expect(api.list).toHaveBeenCalledWith({ state: "closed" });
    await closeMenu();

    await page.getByRole("button", { name: "Remove filter: Closed" }).click();
    await expectRows([44, 43, 42, 41]);
    expect(document.querySelector('[aria-label="Active filters"]')).toBeNull();
  });

  it("moves the kind selection with the arrow keys", async () => {
    await mount();
    await expectRows([44, 43, 42, 41]);

    (document.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expectRows([44, 41]);
    await expect.element(page.getByRole("radio", { name: /^Pull requests/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await expectRows([43, 42]);
  });
});

describe("GitHubInbox selection", () => {
  it("opens an issue from the list and puts the selection in the URL", async () => {
    await mount();
    await expectRows([44, 43, 42, 41]);

    await page
      .getByRole("button", { name: /Crash on launch/ })
      .first()
      .click();

    expect(latestSearch).toMatchObject({
      kind: "issue",
      selectedProjectId: projectA,
      selectedRepo: "acme/widgets",
      number: 42,
    });
    await expect.element(page.getByRole("heading", { name: "Crash on launch" })).toBeVisible();
    await expect.element(page.getByText("Issue #42")).toBeVisible();
    await expect.element(page.getByText("Reproduced on the beta build.")).toBeVisible();
    await expect
      .element(document.querySelector<HTMLElement>('[data-pull-request-number="42"]')!)
      .toHaveAttribute("aria-current", "true");

    await page.getByRole("button", { name: "Open on GitHub" }).click();
    expect(api.openExternal).toHaveBeenCalledWith("https://github.com/acme/widgets/issues/42");
  });

  it("opens a pull request deep link from the old page, which carried no kind", async () => {
    await mount({ selectedProjectId: projectA, selectedRepo: "acme/widgets", number: 41 });

    await expect.element(page.getByRole("heading", { name: "Fix login redirect" })).toBeVisible();
    await expect.element(page.getByText("PR #41")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Summary" })).toBeVisible();
    expect(api.pullRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: projectA, repository: "acme/widgets", number: 41 }),
    );
  });

  it("returns focus to the row after going back on a narrow window", async () => {
    await page.viewport(500, 800);
    await mount();
    await expectRows([44, 43, 42, 41]);

    await page
      .getByRole("button", { name: /Crash on launch/ })
      .first()
      .click();
    await expect.element(page.getByRole("heading", { name: "Crash on launch" })).toBeVisible();
    // The detail takes the list's place.
    expect(visibleRowNumbers()).toEqual([]);

    await page.getByRole("button", { name: "Back to code review" }).first().click();
    await expectRows([44, 43, 42, 41]);
    await expect
      .poll(() => (document.activeElement as HTMLElement | null)?.dataset.pullRequestNumber)
      .toBe("42");
    expect(latestSearch.number).toBeUndefined();
  });
});

describe("GitHubInbox states", () => {
  it("shows the loading skeleton until the list arrives", async () => {
    let resolveList: ((result: GitHubInboxListResult) => void) | undefined;
    api.list.mockImplementation(
      () => new Promise<GitHubInboxListResult>((resolve) => (resolveList = resolve)),
    );
    await mount();

    await expect.element(page.getByLabelText("Loading code review")).toBeInTheDocument();
    resolveList?.(listResult());
    await expectRows([44, 43, 42, 41]);
  });

  it("explains an unavailable GitHub CLI", async () => {
    api.list.mockRejectedValue({
      _tag: "PullRequestsUnavailableError",
      reason: "gh-not-authenticated",
      message: "gh is not authenticated",
    });
    await mount();

    await expect.element(page.getByText("Sign in to GitHub CLI")).toBeVisible();
    await expect.element(page.getByText("gh auth login")).toBeVisible();
  });

  it("shows the reset time when the first load is rate limited", async () => {
    api.list.mockRejectedValue({
      _tag: "PullRequestsUnavailableError",
      reason: "rate-limited",
      message: "API rate limit exceeded",
      retryAt: "2026-09-29T09:30:00.000Z",
    });
    await mount();

    await expect.element(page.getByText("GitHub rate limit reached")).toBeVisible();
    await expect
      .element(page.getByText(/Synara pauses GitHub requests until the limit resets at/))
      .toBeVisible();
  });

  it("keeps cached rows with a note when a repository is rate limited", async () => {
    api.list.mockResolvedValue(
      listResult({
        errors: [
          {
            projectId: projectA,
            projectTitle: "Alpha",
            repository: "acme/widgets",
            message: "API rate limit exceeded",
            reason: "rate-limited",
            retryAt: "2026-09-29T09:30:00.000Z",
            showingCachedData: true,
          },
        ],
      }),
    );
    await mount();

    await expectRows([44, 43, 42, 41]);
    await expect
      .element(page.getByText(/GitHub rate limit reached\. Showing the last loaded items\./))
      .toBeVisible();
  });

  it("says when there is nothing to show", async () => {
    api.list.mockResolvedValue(listResult({ items: [] }));
    await mount();

    await expect.element(page.getByText("No pull requests and issues found")).toBeVisible();
  });
});
