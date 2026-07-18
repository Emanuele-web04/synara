import type { GitHubRepositorySummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { filterGitHubRepositories } from "./GitHubProjectDialog";

const repositories: GitHubRepositorySummary[] = [
  {
    nameWithOwner: "octocat/private-tools",
    url: "https://github.com/octocat/private-tools",
    description: "Developer tooling",
    defaultBranch: "main",
    pushedAt: "2026-07-14T10:00:00Z",
    isPrivate: true,
    isArchived: false,
  },
  {
    nameWithOwner: "example-org/storefront",
    url: "https://github.com/example-org/storefront",
    description: "Customer-facing shop",
    defaultBranch: "release-next",
    pushedAt: null,
    isPrivate: false,
    isArchived: false,
  },
];

describe("filterGitHubRepositories", () => {
  it("matches repository owners, names, descriptions, and default branches", () => {
    expect(filterGitHubRepositories(repositories, "octocat")).toEqual([repositories[0]]);
    expect(filterGitHubRepositories(repositories, "shop")).toEqual([repositories[1]]);
    expect(filterGitHubRepositories(repositories, "RELEASE-NEXT")).toEqual([repositories[1]]);
  });

  it("preserves GitHub's recency order for an empty query", () => {
    expect(filterGitHubRepositories(repositories, "  ")).toEqual(repositories);
  });
});
