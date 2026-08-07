import { describe, expect, it } from "vitest";

import { resolveDiffEditBaseRev } from "./diffEditBaseRev";

describe("resolveDiffEditBaseRev", () => {
  it("compares working-tree style scopes against HEAD", () => {
    expect(resolveDiffEditBaseRev("workingTree", null, "origin/main")).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("unstaged", null, "origin/main")).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("staged", null, "origin/main")).toEqual({ rev: "HEAD" });
  });

  it("compares the branch scope against the upstream merge base", () => {
    expect(resolveDiffEditBaseRev("branch", null, "origin/main")).toEqual({
      mergeBaseWith: "origin/main",
    });
  });

  it("falls back to HEAD when the branch has no upstream", () => {
    expect(resolveDiffEditBaseRev("branch", null, null)).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("branch", null, "   ")).toEqual({ rev: "HEAD" });
  });

  it("uses the compare ref for the ref scope", () => {
    expect(resolveDiffEditBaseRev("ref", "v1.2.0", null)).toEqual({ rev: "v1.2.0" });
    expect(resolveDiffEditBaseRev("ref", "  release  ", null)).toEqual({ rev: "release" });
  });

  it("falls back to HEAD when the ref scope has no ref", () => {
    expect(resolveDiffEditBaseRev("ref", null, "origin/main")).toEqual({ rev: "HEAD" });
    expect(resolveDiffEditBaseRev("ref", "", "origin/main")).toEqual({ rev: "HEAD" });
  });
});
