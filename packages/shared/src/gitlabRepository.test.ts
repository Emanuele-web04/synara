import { describe, expect, it } from "vitest";
import {
  gitlabAbsoluteUrl,
  gitlabMergeRequestUrl,
  gitlabProjectApiPath,
  gitlabProjectWebUrl,
  isValidGitLabHost,
  isValidGitLabProjectPath,
  parseGitLabMergeRequestUrl,
  parseGitLabRepositoryInput,
  parseGitLabRepositoryReference,
} from "./gitlabRepository";

describe("isValidGitLabHost", () => {
  it("accepts gitlab.com, self-hosted hosts, and ports", () => {
    expect(isValidGitLabHost("gitlab.com")).toBe(true);
    expect(isValidGitLabHost("gitlab.dotblocks.fr")).toBe(true);
    expect(isValidGitLabHost("git.example.co.uk:8443")).toBe(true);
  });

  it("rejects hosts without a dot, with spaces, or over-long", () => {
    expect(isValidGitLabHost("localhost")).toBe(false);
    expect(isValidGitLabHost("git lab.com")).toBe(false);
    expect(isValidGitLabHost(`${"a".repeat(250)}.com`)).toBe(false);
  });
});

describe("isValidGitLabProjectPath", () => {
  it("accepts subgroup nesting", () => {
    expect(isValidGitLabProjectPath("acme/app")).toBe(true);
    expect(isValidGitLabProjectPath("dotblocks/platform/app")).toBe(true);
  });

  it("rejects single segments, traversal, and .git suffixes", () => {
    expect(isValidGitLabProjectPath("acme")).toBe(false);
    expect(isValidGitLabProjectPath("acme/../app")).toBe(false);
    expect(isValidGitLabProjectPath("acme/app.git")).toBe(false);
    expect(isValidGitLabProjectPath("acme//app")).toBe(false);
  });
});

describe("parseGitLabRepositoryReference", () => {
  it("round-trips a self-hosted subgroup reference", () => {
    expect(parseGitLabRepositoryReference("gitlab.dotblocks.fr/dotblocks/platform/app")).toEqual({
      host: "gitlab.dotblocks.fr",
      fullPath: "dotblocks/platform/app",
    });
  });

  it("lower-cases the host but preserves project path casing", () => {
    expect(parseGitLabRepositoryReference("GitLab.COM/Acme/App")).toEqual({
      host: "gitlab.com",
      fullPath: "Acme/App",
    });
  });

  it("rejects references whose leading segment is not a hostname", () => {
    expect(parseGitLabRepositoryReference("acme/app")).toBeNull();
    expect(parseGitLabRepositoryReference("gitlab.com/acme")).toBeNull();
    expect(parseGitLabRepositoryReference("")).toBeNull();
    expect(parseGitLabRepositoryReference(null)).toBeNull();
  });
});

describe("parseGitLabRepositoryInput", () => {
  it("defaults a bare project path to gitlab.com", () => {
    expect(parseGitLabRepositoryInput("dotblocks/platform/app")).toBe(
      "gitlab.com/dotblocks/platform/app",
    );
  });

  it("accepts an explicit host and project URLs", () => {
    expect(parseGitLabRepositoryInput("gitlab.dotblocks.fr/acme/app")).toBe(
      "gitlab.dotblocks.fr/acme/app",
    );
    expect(
      parseGitLabRepositoryInput("https://gitlab.dotblocks.fr/dotblocks/platform/app.git"),
    ).toBe("gitlab.dotblocks.fr/dotblocks/platform/app");
    expect(parseGitLabRepositoryInput("https://gitlab.com/acme/app/")).toBe("gitlab.com/acme/app");
  });

  it("rejects resource URLs and unusable input", () => {
    expect(parseGitLabRepositoryInput("https://gitlab.com/acme/app/-/merge_requests/1")).toBeNull();
    expect(parseGitLabRepositoryInput("acme")).toBeNull();
    expect(parseGitLabRepositoryInput("   ")).toBeNull();
  });
});

describe("parseGitLabMergeRequestUrl", () => {
  it("extracts reference and number", () => {
    expect(parseGitLabMergeRequestUrl("https://gitlab.com/a/b/-/merge_requests/12")).toEqual({
      reference: "gitlab.com/a/b",
      number: 12,
    });
    expect(
      parseGitLabMergeRequestUrl(
        "https://gitlab.dotblocks.fr/dotblocks/platform/engine/-/merge_requests/788/diffs",
      ),
    ).toEqual({ reference: "gitlab.dotblocks.fr/dotblocks/platform/engine", number: 788 });
  });

  it("rejects GitHub URLs and malformed numbers", () => {
    expect(parseGitLabMergeRequestUrl("https://github.com/a/b/pull/3")).toBeNull();
    expect(parseGitLabMergeRequestUrl("https://gitlab.com/a/b/-/merge_requests/0")).toBeNull();
  });
});

describe("url builders", () => {
  it("builds merge request, project, and API URLs", () => {
    expect(gitlabMergeRequestUrl("gitlab.dotblocks.fr/dotblocks/platform/app", 7)).toBe(
      "https://gitlab.dotblocks.fr/dotblocks/platform/app/-/merge_requests/7",
    );
    expect(gitlabProjectWebUrl("gitlab.com/acme/app")).toBe("https://gitlab.com/acme/app");
    expect(gitlabProjectApiPath("gitlab.com/dotblocks/platform/app")).toBe(
      "projects/dotblocks%2Fplatform%2Fapp",
    );
    expect(gitlabProjectApiPath("acme/app")).toBeNull();
  });

  it("absolutizes host-relative self-hosted URLs", () => {
    expect(gitlabAbsoluteUrl("gitlab.dotblocks.fr", "/uploads/x/avatar.png")).toBe(
      "https://gitlab.dotblocks.fr/uploads/x/avatar.png",
    );
    expect(gitlabAbsoluteUrl("gitlab.dotblocks.fr", "https://cdn.example/a.png")).toBe(
      "https://cdn.example/a.png",
    );
    expect(gitlabAbsoluteUrl("gitlab.com", null)).toBeNull();
    expect(gitlabAbsoluteUrl("gitlab.com", "relative/path")).toBeNull();
  });
});
