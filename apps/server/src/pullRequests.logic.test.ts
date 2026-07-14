import { describe, expect, it } from "vitest";

import {
  isPullRequestMergeMethodAllowed,
  isValidGitHubRepositoryNameWithOwner,
  isViewerReviewRequested,
  pullRequestListCacheKey,
} from "./pullRequests.logic";

describe("isValidGitHubRepositoryNameWithOwner", () => {
  it.each(["openai/codex", "OpenAI/Codex.js", "owner-1/repo_name"])("accepts %s", (repository) =>
    expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(true),
  );

  it.each([
    "",
    "owner",
    "owner/repo/extra",
    "owner repo/name",
    "-owner/name",
    "owner/--flag value",
  ])("rejects %s", (repository) =>
    expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(false),
  );
});

describe("pullRequestListCacheKey", () => {
  it("separates involvement filters and normalizes repository casing", () => {
    expect(pullRequestListCacheKey("OpenAI/Codex", "open", "authored", "OctoCat")).toBe(
      "openai/codex:open:authored:octocat",
    );
    expect(pullRequestListCacheKey("openai/codex", "open", "reviewing", "octocat")).not.toBe(
      pullRequestListCacheKey("openai/codex", "open", "all", "octocat"),
    );
  });

  it("separates cached lists belonging to different authenticated viewers", () => {
    expect(pullRequestListCacheKey("openai/codex", "open", "authored", "alice")).not.toBe(
      pullRequestListCacheKey("openai/codex", "open", "authored", "bob"),
    );
  });
});

describe("isViewerReviewRequested", () => {
  const viewer = { login: "Viewer", name: null, avatarUrl: null, url: null };
  const teammate = { login: "teammate", name: null, avatarUrl: null, url: null };

  it("does not flag a self-authored pull request", () => {
    expect(isViewerReviewRequested(viewer, ["viewer"], "VIEWER")).toBe(false);
  });

  it("flags a teammate pull request that explicitly requests the viewer", () => {
    expect(isViewerReviewRequested(teammate, ["Viewer"], "viewer")).toBe(true);
  });

  it("flags team-only matches returned by the reviewing query", () => {
    expect(isViewerReviewRequested(teammate, [], "viewer", true)).toBe(true);
  });

  it("does not flag self-authored matches returned by the reviewing query", () => {
    expect(isViewerReviewRequested(viewer, [], "viewer", true)).toBe(false);
  });
});

describe("isPullRequestMergeMethodAllowed", () => {
  const capabilities = {
    merge: false,
    squash: true,
    rebase: false,
    deleteBranchOnMerge: true,
  };

  it("uses repository capabilities for the requested method", () => {
    expect(isPullRequestMergeMethodAllowed(capabilities, "squash")).toBe(true);
    expect(isPullRequestMergeMethodAllowed(capabilities, "merge")).toBe(false);
  });
});
