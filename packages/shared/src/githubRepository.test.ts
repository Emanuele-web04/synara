import { describe, expect, it } from "vitest";

import {
  isValidGitHubRepositoryNameWithOwner,
  parseGitHubRepositoryNameWithOwnerFromPullRequestUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "./githubRepository";

describe("isValidGitHubRepositoryNameWithOwner", () => {
  it.each(["openai/codex", "OpenAI/Codex.js", "owner-1/repo_name", "owner/.github"])(
    "accepts %s",
    (repository) => expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(true),
  );

  it.each([
    "",
    "owner",
    "owner/repo/extra",
    "owner repo/name",
    "-owner/name",
    "owner-/name",
    "owner/..",
    `owner/${"x".repeat(101)}`,
  ])("rejects %s", (repository) =>
    expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(false),
  );
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it.each([
    ["git@github.com:openai/codex.git", "openai/codex"],
    ["ssh://git@github.com/openai/codex.git", "openai/codex"],
    ["https://github.com/openai/codex", "openai/codex"],
    ["git://github.com/openai/codex/", "openai/codex"],
    [" HTTPS://GITHUB.COM/OpenAI/Codex.git ", "OpenAI/Codex"],
  ])("parses %s", (remote, expected) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote)).toBe(expected);
  });

  it.each([
    ["git@git.acme.test:platform/widgets.git", "platform/widgets"],
    ["https://git.acme.test/platform/widgets", "platform/widgets"],
  ])("parses enterprise remote %s", (remote, expected) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote, "git.acme.test")).toBe(expected);
  });

  it.each([
    null,
    "",
    "https://gitlab.com/openai/codex",
    "https://github.com/owner",
    "https://github.com/-owner/repo",
  ])("rejects unsupported remote %s", (remote) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remote)).toBeNull();
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromPullRequestUrl", () => {
  it.each([
    ["https://github.com/openai/codex/pull/123", "openai/codex"],
    ["https://github.com/OpenAI/Codex/pull/123/files", "OpenAI/Codex"],
    ["http://github.com/openai/codex/pull/123?diff=split", "openai/codex"],
    ["https://git.acme.test/platform/widgets/pull/42", "platform/widgets"],
  ])("parses %s", (url, expected) => {
    expect(parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(url)).toBe(expected);
  });

  it.each([
    null,
    "",
    "https://github.com/openai/codex/issues/1",
    "https://github.com/-owner/codex/pull/1",
    "javascript:alert(1)",
  ])("rejects unsupported URL %s", (url) => {
    expect(parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(url)).toBeNull();
  });
});
