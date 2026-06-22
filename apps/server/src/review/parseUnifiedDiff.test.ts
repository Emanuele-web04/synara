import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "./parseUnifiedDiff.ts";

describe("parseUnifiedDiff", () => {
  it("returns [] for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("parses a single modified file with exact insertion/deletion counts", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,4 +1,5 @@",
      " const a = 1;",
      "-const stale = 2;",
      "+const fresh = 2;",
      "+const added = 3;",
      " const b = 4;",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/app.ts", insertions: 2, deletions: 1, status: "modified" },
    ]);
  });

  it("parses a new file as status 'added'", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,3 @@",
      "+export const x = 1;",
      "+export const y = 2;",
      "+export const z = 3;",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/new.ts", insertions: 3, deletions: 0, status: "added" },
    ]);
  });

  it("parses a deleted file as status 'deleted'", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-const gone = 1;",
      "-const removed = 2;",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/old.ts", insertions: 0, deletions: 2, status: "deleted" },
    ]);
  });

  it("parses a pure rename as status 'renamed' using the new path", () => {
    const patch = [
      "diff --git a/src/before.ts b/src/after.ts",
      "similarity index 100%",
      "rename from src/before.ts",
      "rename to src/after.ts",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/after.ts", insertions: 0, deletions: 0, status: "renamed" },
    ]);
  });

  it("parses a rename with edits using the new path and counting only content changes", () => {
    const patch = [
      "diff --git a/src/before.ts b/src/after.ts",
      "similarity index 80%",
      "rename from src/before.ts",
      "rename to src/after.ts",
      "index 5555555..6666666 100644",
      "--- a/src/before.ts",
      "+++ b/src/after.ts",
      "@@ -1,2 +1,2 @@",
      " const keep = 1;",
      "-const old = 2;",
      "+const renamed = 2;",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/after.ts", insertions: 1, deletions: 1, status: "renamed" },
    ]);
  });

  it("parses multiple files in one diff separately with correct counts", () => {
    const patch = [
      "diff --git a/src/one.ts b/src/one.ts",
      "index aaaaaaa..bbbbbbb 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "diff --git a/src/two.ts b/src/two.ts",
      "new file mode 100644",
      "index 0000000..ccccccc",
      "--- /dev/null",
      "+++ b/src/two.ts",
      "@@ -0,0 +1,2 @@",
      "+const c = 1;",
      "+const d = 2;",
      "diff --git a/src/three.ts b/src/three.ts",
      "deleted file mode 100644",
      "index ddddddd..0000000",
      "--- a/src/three.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-const gone = 1;",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/one.ts", insertions: 1, deletions: 1, status: "modified" },
      { path: "src/two.ts", insertions: 2, deletions: 0, status: "added" },
      { path: "src/three.ts", insertions: 0, deletions: 1, status: "deleted" },
    ]);
  });

  it("does not count +++/--- header lines or @@ hunk headers as changes", () => {
    const patch = [
      "diff --git a/src/headers.ts b/src/headers.ts",
      "index 7777777..8888888 100644",
      "--- a/src/headers.ts",
      "+++ b/src/headers.ts",
      "@@ -1,3 +1,3 @@ function ctx() {",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      "",
    ].join("\n");

    const result = parseUnifiedDiff(patch);
    expect(result).toEqual([
      { path: "src/headers.ts", insertions: 1, deletions: 1, status: "modified" },
    ]);
  });

  it("does not miscount a missing trailing newline marker", () => {
    const patch = [
      "diff --git a/src/eol.ts b/src/eol.ts",
      "index 9999999..aaaaaaa 100644",
      "--- a/src/eol.ts",
      "+++ b/src/eol.ts",
      "@@ -1,1 +1,1 @@",
      "-const noeol = 1;",
      "\\ No newline at end of file",
      "+const noeol = 2;",
      "\\ No newline at end of file",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/eol.ts", insertions: 1, deletions: 1, status: "modified" },
    ]);
  });

  it("decodes git-quoted UTF-8 paths", () => {
    const patch = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      "index 1111111..2222222 100644",
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "src/café.ts", insertions: 1, deletions: 1, status: "modified" },
    ]);
  });

  it("keeps paths with literal b segments aligned with the patch", () => {
    const patch = [
      "diff --git a/dir/ b/name.txt b/dir/ b/name.txt",
      "index 1111111..2222222 100644",
      "--- a/dir/ b/name.txt",
      "+++ b/dir/ b/name.txt",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(patch)).toEqual([
      { path: "dir/ b/name.txt", insertions: 1, deletions: 1, status: "modified" },
    ]);
  });
});
