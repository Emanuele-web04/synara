import { describe, expect, it } from "vitest";

import type { OrchestrationWorktreeWorkspace } from "@synara/contracts";

import {
  canonicalPullRequestIdentity,
  contextualWorkspaceGitAction,
  deriveWorkspaceGitPresentationState,
  findWorkspaceForPullRequest,
  presentPullRequestState,
  pullRequestsMatch,
} from "./pullRequest";

describe("pull request identity", () => {
  it("matches canonical PR identity across URL formatting differences", () => {
    const left = { number: 42, url: "https://github.com/Acme/Repo/pull/42" };
    const right = { number: 42, url: "https://github.com/acme/repo/pull/42/" };
    expect(canonicalPullRequestIdentity(left)).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "repo",
      number: 42,
    });
    expect(pullRequestsMatch(left, right)).toBe(true);
  });

  it("does not conflate the same PR number across repositories", () => {
    expect(
      pullRequestsMatch(
        { number: 42, url: "https://github.com/acme/one/pull/42" },
        { number: 42, url: "https://github.com/acme/two/pull/42" },
      ),
    ).toBe(false);
  });

  it("finds a workspace by canonical PR identity or source reference", () => {
    const workspace = {
      id: "workspace-1",
      projectId: "project-1",
      deletedAt: null,
      sourceRef: null,
      lastKnownPr: { number: 42, url: "https://github.com/acme/repo/pull/42" },
    } as OrchestrationWorktreeWorkspace;
    expect(
      findWorkspaceForPullRequest([workspace], "project-1", {
        number: 42,
        url: "https://github.com/ACME/REPO/pull/42/",
      }),
    ).toBe(workspace);

    const sourceWorkspace = {
      ...workspace,
      id: "workspace-2",
      sourceRef: "https://github.com/acme/repo/pull/7",
      lastKnownPr: null,
    } as OrchestrationWorktreeWorkspace;
    expect(
      findWorkspaceForPullRequest([sourceWorkspace], "project-1", {
        number: 7,
        url: "https://github.com/ACME/REPO/pull/7/",
      }),
    ).toBe(sourceWorkspace);
  });
});

describe("workspace Git presentation", () => {
  it("derives the PR lifecycle before publication fallback", () => {
    expect(
      deriveWorkspaceGitPresentationState({
        workspaceState: "ready",
        hasBranch: true,
        published: false,
        pr: {
          number: 42,
          title: "Ship it",
          url: "https://github.com/acme/repo/pull/42",
          baseBranch: "main",
          headBranch: "feature",
          state: "merged",
        },
      }),
    ).toBe("pr-merged");
    expect(presentPullRequestState({ state: "open", isDraft: true })).toBe("Draft PR");
    expect(contextualWorkspaceGitAction("local-only")).toEqual({
      label: "Publish branch",
      available: true,
    });
  });
});
