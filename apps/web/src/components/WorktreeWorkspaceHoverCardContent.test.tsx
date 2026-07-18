// FILE: WorktreeWorkspaceHoverCardContent.test.tsx
// Purpose: Covers worktree hover-card metadata and active conversation wording.
// Layer: Component unit tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatOpenConversationCount,
  WorktreeWorkspaceHoverCardContent,
} from "./WorktreeWorkspaceHoverCardContent";

describe("formatOpenConversationCount", () => {
  it("makes the active-only meaning explicit", () => {
    expect(formatOpenConversationCount(0)).toBe("No open conversations");
    expect(formatOpenConversationCount(1)).toBe("1 open conversation");
    expect(formatOpenConversationCount(2)).toBe("2 open conversations");
  });
});

describe("WorktreeWorkspaceHoverCardContent", () => {
  it("links only an explicitly verified branch and exposes authoritative actions", () => {
    const markup = renderToStaticMarkup(
      <WorktreeWorkspaceHoverCardContent
        title="Seller catalog"
        branch="synara/seller-catalog"
        branchUrl="https://github.com/example/repo/tree/guessed"
        path="~/.synara/worktrees/seller-catalog"
        branchPresentation={{
          name: "synara/seller-catalog",
          verifiedUrl: "https://github.com/example/repo/tree/synara/seller-catalog",
        }}
        pathPresentation={{
          displayPath: "~/.synara/worktrees/seller-catalog",
          absolutePath: "/Users/developer/.synara/worktrees/seller-catalog",
          revealLabel: "Show in Finder",
        }}
        publicationLabel="PR open"
        pullRequest={{ number: 42, stateLabel: "Open", actionLabel: "Open pull request #42" }}
        source="main"
        status="ready"
        openConversationCount={2}
        onOpenBranch={() => undefined}
        onRevealPath={() => undefined}
        onOpenPullRequest={() => undefined}
      />,
    );

    expect(markup).toContain("Seller catalog");
    expect(markup).toContain('aria-label="Open synara/seller-catalog on GitHub"');
    expect(markup).not.toContain("/tree/guessed");
    expect(markup).toContain("~/.synara/worktrees/seller-catalog");
    expect(markup).toContain('aria-label="Show in Finder: ~/.synara/worktrees/seller-catalog"');
    expect(markup).toContain("Started from");
    expect(markup).toContain("PR open");
    expect(markup).toContain('aria-label="Open pull request #42"');
    expect(markup).toContain("2 open conversations");
  });

  it("keeps local-only branch text plain even when a legacy guessed URL is supplied", () => {
    const markup = renderToStaticMarkup(
      <WorktreeWorkspaceHoverCardContent
        title="Local changes"
        branch="synara/local-changes"
        branchUrl="https://github.com/example/repo/tree/synara/local-changes"
        path="/tmp/local-changes"
        publicationLabel="Local only"
        source="main"
        status="ready"
        openConversationCount={0}
        onOpenBranch={() => undefined}
      />,
    );

    expect(markup).toContain("synara/local-changes");
    expect(markup).toContain("Local only");
    expect(markup).not.toContain("href=");
  });
});
