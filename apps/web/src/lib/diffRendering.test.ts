// FILE: diffRendering.test.ts
// Purpose: Verifies shared git patch helpers used by diff chrome and header badges.
// Layer: Web diff utility tests
// Depends on: Vitest and diffRendering helpers

import { describe, expect, it } from "vitest";
import { buildPatchCacheKey, resolveDiffCopyText, summarizePatchStats } from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("resolveDiffCopyText", () => {
  it("preserves the original patch content for clipboard writes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')\n";

    expect(resolveDiffCopyText(patch)).toBe(patch);
  });

  it("does not expose empty or missing patches as copyable", () => {
    expect(resolveDiffCopyText(undefined)).toBeNull();
    expect(resolveDiffCopyText(" \n\t ")).toBeNull();
  });
});

describe("summarizePatchStats", () => {
  it("summarizes additions and deletions from a unified patch", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,4 @@",
      " const stable = true;",
      "-const oldValue = 1;",
      "+const newValue = 1;",
      "+const addedValue = 2;",
      " export { stable };",
      "",
    ].join("\n");

    expect(summarizePatchStats(patch)).toEqual({ additions: 2, deletions: 1 });
  });
});
