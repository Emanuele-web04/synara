// FILE: PullRequestRow.browser.tsx
// Purpose: Browser-level regression coverage for the separate row-select and pin controls, and
//          for issue rows (glyph, labels, comment count) in the shared inbox row.
// Layer: Pull request presentation test

import "../../index.css";

import type {
  GitHubInboxIssueItem,
  GitHubInboxItem,
  GitHubInboxPullRequestItem,
  PullRequestListEntry,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { PullRequestAvatar } from "./PullRequestAvatar";
import { PullRequestList } from "./PullRequestList";
import { PullRequestRow } from "./PullRequestRow";
import { groupPullRequestEntriesByInvolvement } from "./pullRequestList.logic";
import { focusPullRequestRow, isFocusInsideRightDock } from "./pullRequestFocus";
import { waitForTransientPopups } from "../../lib/browserPopupCleanup";

function makeEntry(isPinned: boolean): GitHubInboxPullRequestItem {
  return {
    kind: "pullRequest",
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Project One",
    repository: "acme/widgets",
    number: 42,
    title: "Prioritize this pull request",
    url: "https://github.com/acme/widgets/pull/42",
    author: null,
    headBranch: "feature/pin",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 2,
    deletions: 1,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned,
    projectContexts: [
      {
        projectId: "project-1" as PullRequestListEntry["projectId"],
        projectTitle: "Project One",
        isPinned,
      },
    ],
    mergeability: "unknown",
    stack: null,
    labels: [],
    commentCount: 0,
    assignees: [],
    viewerInvolvement: { authored: false, assigned: false, involved: false },
  };
}

function makeIssue(overrides: Partial<GitHubInboxIssueItem> = {}): GitHubInboxIssueItem {
  const projectId = "project-1" as GitHubInboxIssueItem["projectId"];
  return {
    kind: "issue",
    projectId,
    projectTitle: "Project One",
    projectContexts: [{ projectId, projectTitle: "Project One", isPinned: false }],
    repository: "acme/widgets",
    number: 7,
    title: "Widgets wobble",
    url: "https://github.com/acme/widgets/issues/7",
    author: null,
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
    closedAt: null,
    isPinned: false,
    viewerInvolvement: { authored: false, assigned: false, involved: false },
    ...overrides,
  };
}

function StatefulGroupedList() {
  const [entry, setEntry] = useState<GitHubInboxItem>(() => makeEntry(false));
  return (
    <PullRequestList
      sort="created"
      groups={groupPullRequestEntriesByInvolvement([entry], null)}
      isSectionOpen={() => true}
      onToggleSection={() => {}}
      isSelected={() => false}
      onSelect={() => {}}
      onTogglePinned={(current) => setEntry({ ...current, isPinned: !current.isPinned })}
    />
  );
}

function FocusRestoreHarness() {
  const entry = makeEntry(false);
  const [dockOpen, setDockOpen] = useState(true);
  const closeDock = () => {
    const shouldRestore = isFocusInsideRightDock(document.activeElement);
    setDockOpen(false);
    if (shouldRestore) {
      requestAnimationFrame(() => focusPullRequestRow(document, entry));
    }
  };
  return (
    <>
      <PullRequestRow entry={entry} selected onClick={() => {}} onTogglePinned={() => {}} />
      {dockOpen ? (
        <div data-right-dock-content>
          <button type="button" onClick={closeDock}>
            Close panel
          </button>
        </div>
      ) : null}
    </>
  );
}

describe("PullRequestRow pin control", () => {
  afterEach(async () => {
    await waitForTransientPopups();
    document.body.innerHTML = "";
  });

  it("pins without also selecting the pull request", async () => {
    const onSelect = vi.fn();
    const onTogglePinned = vi.fn();
    await render(
      <PullRequestRow
        entry={makeEntry(false)}
        selected={false}
        onClick={onSelect}
        onTogglePinned={onTogglePinned}
      />,
    );

    await page.getByRole("button", { name: "Pin pull request #42" }).click();

    expect(onTogglePinned).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pin pull request #42");
    expect(page.getByRole("img", { name: "PR open" })).toBeVisible();
    expect(
      document
        .querySelector('button[aria-label="Pin pull request #42"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("exposes the persisted pinned state as a dedicated sibling button", async () => {
    await render(
      <PullRequestRow
        entry={makeEntry(true)}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    const pinButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Unpin pull request #42"]',
    );
    expect(pinButton?.getAttribute("aria-pressed")).toBe("true");
    expect(pinButton?.querySelector("button")).toBeNull();
    expect(pinButton?.parentElement?.closest("button")).toBeNull();
  });

  it("keeps pin focus when the row moves into the Pinned group", async () => {
    await render(<StatefulGroupedList />);

    await page.getByRole("button", { name: "Pin pull request #42" }).click();

    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("Unpin pull request #42");
    expect(document.body.textContent).toContain("Pinned");
  });

  it("shows project identity in all-project rows and their pin labels", async () => {
    await render(
      <PullRequestRow
        entry={makeEntry(false)}
        selected={false}
        showProjectTitle
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    expect(page.getByText("Project One")).toBeVisible();
    expect(page.getByRole("button", { name: "Pin pull request #42 in Project One" })).toBeVisible();
  });

  it("restores focus by remote identity when aggregate project context changes", async () => {
    const entry = makeEntry(false);
    await render(
      <PullRequestRow entry={entry} selected={false} onClick={vi.fn()} onTogglePinned={vi.fn()} />,
    );

    expect(
      focusPullRequestRow(document, {
        ...entry,
        projectId: "different-project" as PullRequestListEntry["projectId"],
      }),
    ).toBe(true);
    expect(document.activeElement?.getAttribute("data-pull-request-number")).toBe("42");
  });

  it("returns focus to the selected row when the focused dock closes", async () => {
    await render(<FocusRestoreHarness />);

    await page.getByRole("button", { name: "Close panel" }).click();

    await vi.waitFor(() => {
      expect(document.activeElement?.hasAttribute("data-pull-request-row")).toBe(true);
    });
    expect(document.activeElement?.getAttribute("data-project-id")).toBe("project-1");
    expect(document.activeElement?.getAttribute("data-pull-request-number")).toBe("42");
  });
});

describe("PullRequestRow issue rows", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the issue glyph, the author, the time, and the number muted at the end", async () => {
    await render(
      <PullRequestRow
        entry={makeIssue({
          author: { login: "octo", name: "Octo Cat", avatarUrl: null, url: null },
          labels: [{ name: "kind:bug", color: "d73a4a" }],
        })}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    await expect.element(page.getByRole("img", { name: "Issue open" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Pin issue #7" })).toBeInTheDocument();
    const row = document.querySelector("[data-pull-request-row]");
    // Display name, not login; the title leads and the number closes the second line.
    expect(row?.textContent).toContain("Octo Cat");
    expect(row?.textContent?.startsWith("Widgets wobble")).toBe(true);
    expect(row?.textContent?.endsWith("#7")).toBe(true);
    // Labels and counts live in the detail, not the row.
    expect(row?.textContent).not.toContain("kind:bug");
  });

  it("lets a long title wrap to two lines instead of truncating after one", async () => {
    await render(
      <PullRequestRow
        entry={makeIssue({ title: "A long issue title ".repeat(8) })}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );
    const title = document.querySelector<HTMLElement>("[data-pull-request-row] > span")!;
    expect(getComputedStyle(title).webkitLineClamp).toBe("2");
  });

  it("marks issues closed as not planned with the struck glyph", async () => {
    await render(
      <PullRequestRow
        entry={makeIssue({ state: "closed", stateReason: "not-planned" })}
        selected={false}
        onClick={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    await expect.element(page.getByRole("img", { name: "Issue not planned" })).toBeVisible();
  });
});

describe("PullRequestAvatar", () => {
  afterEach(async () => {
    await waitForTransientPopups();
    document.body.innerHTML = "";
  });

  it("does not derive an image URL from a team slug", async () => {
    await render(
      <PullRequestAvatar
        actor={{
          login: "platform-team",
          name: null,
          avatarUrl: null,
          url: null,
        }}
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("P");
  });
});
