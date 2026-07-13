import { describe, expect, it } from "vitest";

import {
  isValidGitHubRepositoryNameWithOwner,
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
