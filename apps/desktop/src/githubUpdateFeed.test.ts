import { describe, expect, it } from "vitest";

import {
  buildGitHubReleaseDownloadBaseUrl,
  pickLatestStableGitHubRelease,
  resolveGitHubUpdateSource,
} from "./githubUpdateFeed";

describe("resolveGitHubUpdateSource", () => {
  it("returns null for non-github providers", () => {
    expect(resolveGitHubUpdateSource({ provider: "generic" })).toBeNull();
  });

  it("normalizes a github source with default host and protocol", () => {
    expect(
      resolveGitHubUpdateSource({
        provider: "github",
        owner: "openai",
        repo: "codex",
      }),
    ).toEqual({
      owner: "openai",
      repo: "codex",
      host: "github.com",
      protocol: "https",
    });
  });
});

describe("pickLatestStableGitHubRelease", () => {
  it("chooses the highest stable semver release instead of the first entry", () => {
    expect(
      pickLatestStableGitHubRelease([
        { tag_name: "v0.0.30", draft: false, prerelease: false },
        { tag_name: "v0.0.31", draft: false, prerelease: false },
      ]),
    ).toEqual({
      tag: "v0.0.31",
      version: "0.0.31",
    });
  });

  it("ignores drafts, prereleases, and invalid tags", () => {
    expect(
      pickLatestStableGitHubRelease([
        { tag_name: "v0.0.32-beta.1", draft: false, prerelease: true },
        { tag_name: "build-123", draft: false, prerelease: false },
        { tag_name: "v0.0.31", draft: true, prerelease: false },
        { tag_name: "v0.0.30", draft: false, prerelease: false },
      ]),
    ).toEqual({
      tag: "v0.0.30",
      version: "0.0.30",
    });
  });
});

describe("buildGitHubReleaseDownloadBaseUrl", () => {
  it("points generic updater traffic at the chosen release tag", () => {
    expect(
      buildGitHubReleaseDownloadBaseUrl(
        {
          owner: "openai",
          repo: "codex",
          host: "github.com",
          protocol: "https",
        },
        "v0.0.31",
      ),
    ).toBe("https://github.com/openai/codex/releases/download/v0.0.31/");
  });
});
