import { describe, expect, it } from "vitest";
import { extractGutterChangeRanges, isWholeFileAddition } from "./editorGutterDiff";

const addedOnlyPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,5 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " const d = 4;",
  " const e = 5;",
  "",
].join("\n");

const deletionOnlyPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,5 +1,3 @@",
  " const a = 1;",
  " const b = 2;",
  "-const c = 3;",
  "-const d = 4;",
  " const e = 5;",
  "",
].join("\n");

const modifiedPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 20;",
  " const c = 3;",
  " const d = 4;",
  "",
].join("\n");

const multiHunkPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "+const inserted = 0;",
  " const b = 2;",
  " const c = 3;",
  " const d = 4;",
  "@@ -20,6 +21,6 @@",
  " const t = 20;",
  " const u = 21;",
  "-const v = 22;",
  "+const v = 220;",
  " const w = 23;",
  " const x = 24;",
  " const y = 25;",
  "",
].join("\n");

const untrackedPatch = [
  "diff --git a/src/fresh.ts b/src/fresh.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/fresh.ts",
  "@@ -0,0 +1,3 @@",
  "+const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  "",
].join("\n");

describe("extractGutterChangeRanges", () => {
  it("marks an addition-only hunk as added", () => {
    expect(extractGutterChangeRanges(addedOnlyPatch, "src/app.ts")).toEqual([
      { kind: "added", startLine: 2, endLine: 3 },
    ]);
  });

  it("collapses a deletion-only run into one marker anchored at the preceding line", () => {
    expect(extractGutterChangeRanges(deletionOnlyPatch, "src/app.ts")).toEqual([
      { kind: "deleted", startLine: 2, endLine: 2 },
    ]);
  });

  it("marks a replaced line as modified", () => {
    expect(extractGutterChangeRanges(modifiedPatch, "src/app.ts")).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
    ]);
  });

  it("reports every hunk in new-file line numbers", () => {
    expect(extractGutterChangeRanges(multiHunkPatch, "src/app.ts")).toEqual([
      { kind: "added", startLine: 2, endLine: 2 },
      { kind: "modified", startLine: 23, endLine: 23 },
    ]);
  });

  it("matches an absolute preview path against repo-relative patch paths", () => {
    expect(extractGutterChangeRanges(addedOnlyPatch, "/Users/dev/repo/src/app.ts")).toEqual([
      { kind: "added", startLine: 2, endLine: 3 },
    ]);
  });

  it("returns nothing when the file is missing from the patch", () => {
    expect(extractGutterChangeRanges(addedOnlyPatch, "src/other.ts")).toEqual([]);
  });

  it("returns nothing without a patch or a path", () => {
    expect(extractGutterChangeRanges(undefined, "src/app.ts")).toEqual([]);
    expect(extractGutterChangeRanges("", "src/app.ts")).toEqual([]);
    expect(extractGutterChangeRanges(addedOnlyPatch, null)).toEqual([]);
  });

  it("covers a new file as one added range", () => {
    expect(extractGutterChangeRanges(untrackedPatch, "src/fresh.ts")).toEqual([
      { kind: "added", startLine: 1, endLine: 3 },
    ]);
  });
});

describe("isWholeFileAddition", () => {
  it("is true for a new file and false for an edited one", () => {
    expect(isWholeFileAddition(untrackedPatch, "src/fresh.ts")).toBe(true);
    expect(isWholeFileAddition(addedOnlyPatch, "src/app.ts")).toBe(false);
    expect(isWholeFileAddition(addedOnlyPatch, "src/missing.ts")).toBe(false);
  });
});
