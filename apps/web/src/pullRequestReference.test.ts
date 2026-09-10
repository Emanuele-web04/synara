import { describe, expect, it } from "vitest";

import { parsePullRequestReference } from "./pullRequestReference";

describe("parsePullRequestReference", () => {
  it("accepts GitHub pull request URLs", () => {
    expect(parsePullRequestReference("https://github.com/example-org/synara/pull/42")).toBe(
      "https://github.com/example-org/synara/pull/42",
    );
  });

  it("accepts GitLab merge request URLs", () => {
    expect(
      parsePullRequestReference("https://gitlab.dotblocks.fr/acme/app/-/merge_requests/12"),
    ).toBe("https://gitlab.dotblocks.fr/acme/app/-/merge_requests/12");
  });

  it("accepts raw numbers", () => {
    expect(parsePullRequestReference("42")).toBe("42");
  });

  it("accepts #number references", () => {
    expect(parsePullRequestReference("#42")).toBe("#42");
  });

  it("normalizes a GitLab !number reference to #number", () => {
    expect(parsePullRequestReference("!42")).toBe("#42");
  });

  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
    expect(parsePullRequestReference("https://example.com/a/b/pull/3")).toBeNull();
  });
});
