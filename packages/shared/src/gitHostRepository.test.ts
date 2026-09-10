import { describe, expect, it } from "vitest";
import {
  gitHostCliName,
  gitHostDisplayName,
  gitHostKindForPullRequestUrl,
  isGitLabHost,
  isValidRepositoryReference,
  parseGitRemoteUrl,
  parsePullRequestUrl,
  parseRepositoryIdentityFromRemoteUrl,
  parseRepositoryReference,
  remoteUrlMatchesRepository,
  repositoryWebUrl,
} from "./gitHostRepository";

const dotblocks = new Set(["gitlab.dotblocks.fr"]);

describe("parseRepositoryReference", () => {
  it("treats a dotless owner as GitHub", () => {
    expect(parseRepositoryReference("acme/app")).toEqual({
      kind: "github",
      reference: "acme/app",
      host: "github.com",
      path: "acme/app",
    });
  });

  it("treats a hostname-leading reference as GitLab, including subgroups", () => {
    expect(parseRepositoryReference("gitlab.dotblocks.fr/dotblocks/platform/app")).toEqual({
      kind: "gitlab",
      reference: "gitlab.dotblocks.fr/dotblocks/platform/app",
      host: "gitlab.dotblocks.fr",
      path: "dotblocks/platform/app",
    });
  });

  it("rejects references that are neither", () => {
    expect(parseRepositoryReference("gitlab.com/acme")).toBeNull();
    expect(parseRepositoryReference("acme")).toBeNull();
    expect(isValidRepositoryReference("acme/app")).toBe(true);
    expect(isValidRepositoryReference("acme")).toBe(false);
  });
});

describe("parseGitRemoteUrl", () => {
  it("handles scp, ssh, https, and git forms", () => {
    expect(parseGitRemoteUrl("git@gitlab.dotblocks.fr:dotblocks/platform/app.git")).toEqual({
      host: "gitlab.dotblocks.fr",
      path: "dotblocks/platform/app",
    });
    expect(parseGitRemoteUrl("ssh://git@gitlab.com:2222/acme/app.git")).toEqual({
      host: "gitlab.com",
      path: "acme/app",
    });
    expect(parseGitRemoteUrl("https://user:token@github.com/acme/app.git/")).toEqual({
      host: "github.com",
      path: "acme/app",
    });
    expect(parseGitRemoteUrl("git://github.com/acme/app")).toEqual({
      host: "github.com",
      path: "acme/app",
    });
  });

  it("rejects paths with fewer than two segments and empty input", () => {
    expect(parseGitRemoteUrl("git@github.com:acme.git")).toBeNull();
    expect(parseGitRemoteUrl("")).toBeNull();
    expect(parseGitRemoteUrl("/local/path")).toBeNull();
  });
});

describe("isGitLabHost", () => {
  it("recognises gitlab.com, the gitlab. prefix, and configured hosts", () => {
    expect(isGitLabHost("gitlab.com", new Set())).toBe(true);
    expect(isGitLabHost("gitlab.internal.example", new Set())).toBe(true);
    expect(isGitLabHost("gitlab.dotblocks.fr", dotblocks)).toBe(true);
    expect(isGitLabHost("code.example.com", new Set())).toBe(false);
  });
});

describe("parseRepositoryIdentityFromRemoteUrl", () => {
  it("resolves github and known gitlab remotes", () => {
    expect(
      parseRepositoryIdentityFromRemoteUrl("git@github.com:acme/app.git", {
        gitlabHosts: new Set(),
      }),
    ).toEqual({ kind: "github", reference: "acme/app", host: "github.com", path: "acme/app" });

    expect(
      parseRepositoryIdentityFromRemoteUrl("git@code.dotblocks.fr:dotblocks/platform/app.git", {
        gitlabHosts: new Set(["code.dotblocks.fr"]),
      }),
    ).toEqual({
      kind: "gitlab",
      reference: "code.dotblocks.fr/dotblocks/platform/app",
      host: "code.dotblocks.fr",
      path: "dotblocks/platform/app",
    });

    expect(
      parseRepositoryIdentityFromRemoteUrl("git@gitlab.dotblocks.fr:dotblocks/platform/app.git", {
        gitlabHosts: new Set(),
      }),
    ).toEqual({
      kind: "gitlab",
      reference: "gitlab.dotblocks.fr/dotblocks/platform/app",
      host: "gitlab.dotblocks.fr",
      path: "dotblocks/platform/app",
    });
  });

  it("ignores an unknown self-hosted host so other forges keep today's behaviour", () => {
    expect(
      parseRepositoryIdentityFromRemoteUrl("git@code.dotblocks.fr:dotblocks/platform/app.git", {
        gitlabHosts: new Set(),
      }),
    ).toBeNull();
    expect(
      parseRepositoryIdentityFromRemoteUrl("git@bitbucket.org:acme/app.git", {
        gitlabHosts: dotblocks,
      }),
    ).toBeNull();
  });
});

describe("remoteUrlMatchesRepository", () => {
  it("compares host and path case-insensitively", () => {
    expect(
      remoteUrlMatchesRepository(
        "git@gitlab.dotblocks.fr:DotBlocks/Platform/App.git",
        "gitlab.dotblocks.fr/dotblocks/platform/app",
      ),
    ).toBe(true);
    expect(remoteUrlMatchesRepository("https://github.com/acme/app.git", "acme/app")).toBe(true);
    expect(remoteUrlMatchesRepository("https://github.com/acme/other.git", "acme/app")).toBe(false);
    expect(remoteUrlMatchesRepository("https://gitlab.com/acme/app", "acme/app")).toBe(false);
  });
});

describe("parsePullRequestUrl", () => {
  it("parses GitHub pull URLs", () => {
    expect(parsePullRequestUrl("https://github.com/a/b/pull/3")).toEqual({
      identity: { kind: "github", reference: "a/b", host: "github.com", path: "a/b" },
      number: 3,
    });
    expect(gitHostKindForPullRequestUrl("https://github.com/a/b/pull/3")).toBe("github");
  });

  it("parses GitLab merge-request URLs", () => {
    expect(parsePullRequestUrl("https://gitlab.com/a/b/-/merge_requests/12")).toEqual({
      identity: {
        kind: "gitlab",
        reference: "gitlab.com/a/b",
        host: "gitlab.com",
        path: "a/b",
      },
      number: 12,
    });
    expect(gitHostKindForPullRequestUrl("https://gitlab.com/a/b/-/merge_requests/12")).toBe(
      "gitlab",
    );
  });

  it("returns null for anything else", () => {
    expect(parsePullRequestUrl("https://example.com/a/b/pull/3")).toBeNull();
    expect(gitHostKindForPullRequestUrl(null)).toBeNull();
  });
});

describe("presentation helpers", () => {
  it("builds web URLs and host labels", () => {
    expect(repositoryWebUrl({ kind: "github", reference: "a/b", host: "github.com", path: "a/b" })).toBe(
      "https://github.com/a/b",
    );
    expect(
      repositoryWebUrl({
        kind: "gitlab",
        reference: "gitlab.dotblocks.fr/a/b",
        host: "gitlab.dotblocks.fr",
        path: "a/b",
      }),
    ).toBe("https://gitlab.dotblocks.fr/a/b");
    expect(gitHostDisplayName("gitlab")).toBe("GitLab");
    expect(gitHostCliName("gitlab")).toBe("glab");
    expect(gitHostCliName("github")).toBe("gh");
  });
});
