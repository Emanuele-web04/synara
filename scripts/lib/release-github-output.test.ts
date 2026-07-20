import { describe, expect, it } from "vitest";

import { serializeReleaseGithubOutput } from "./release-github-output";

describe("serializeReleaseGithubOutput", () => {
  it("preserves field order, empty values, and the trailing newline", () => {
    expect(
      serializeReleaseGithubOutput({
        source_commit: "0123456789abcdef",
        source_tag: "",
        lockfile_sha256: "fedcba9876543210",
      }),
    ).toBe(
      [
        "source_commit=0123456789abcdef",
        "source_tag=",
        "lockfile_sha256=fedcba9876543210",
        "",
      ].join("\n"),
    );
  });
});
