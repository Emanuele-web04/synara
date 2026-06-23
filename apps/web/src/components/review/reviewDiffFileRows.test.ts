import { describe, expect, it } from "vitest";

import { buildReviewDiffFileRows, splitUnifiedDiffByFile } from "./reviewDiffFileRows";

const MIXED_PATCH = [
  "diff --git a/src/plain.ts b/src/plain.ts",
  "index 1111111..2222222 100644",
  "--- a/src/plain.ts",
  "+++ b/src/plain.ts",
  "@@ -1 +1 @@",
  "-old plain",
  "+new plain",
  "diff --git a/src/foo bar.ts b/src/foo bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/foo bar.ts",
  "+++ b/src/foo bar.ts",
  "@@ -1 +1 @@",
  "-old spaced",
  "+new spaced",
].join("\n");

const QUOTED_PATCH = [
  'diff --git "a/src/quoted file.ts" "b/src/quoted file.ts"',
  "index 5555555..6666666 100644",
  '--- "a/src/quoted file.ts"',
  '+++ "b/src/quoted file.ts"',
  "@@ -1 +1 @@",
  "-old quoted",
  "+new quoted",
].join("\n");

const ESCAPED_QUOTED_PATCH = [
  'diff --git "a/src/file\\"quote.ts" "b/src/file\\"quote.ts"',
  "index 7777777..8888888 100644",
  '--- "a/src/file\\"quote.ts"',
  '+++ "b/src/file\\"quote.ts"',
  "@@ -1 +1 @@",
  "-old escaped",
  "+new escaped",
].join("\n");

const LITERAL_B_SEGMENT_PATCH = [
  "diff --git a/dir/ b/name.txt b/dir/ b/name.txt",
  "index 9999999..aaaaaaa 100644",
  "--- a/dir/ b/name.txt",
  "+++ b/dir/ b/name.txt",
  "@@ -1 +1 @@",
  "-old literal",
  "+new literal",
].join("\n");

const OCTAL_QUOTED_PATCH = [
  'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
  "index bbbbbbb..ccccccc 100644",
  '--- "a/src/caf\\303\\251.ts"',
  '+++ "b/src/caf\\303\\251.ts"',
  "@@ -1 +1 @@",
  "-old octal",
  "+new octal",
].join("\n");

const RENAME_PATCH = [
  "diff --git a/src/before name.ts b/dst/after name.ts",
  "similarity index 95%",
  "rename from src/before name.ts",
  "rename to dst/after name.ts",
].join("\n");

describe("review diff file rows", () => {
  it("keeps every file in a mixed patch when one path contains spaces", () => {
    expect(splitUnifiedDiffByFile(MIXED_PATCH).map((section) => section.path)).toEqual([
      "src/plain.ts",
      "src/foo bar.ts",
    ]);

    const rows = buildReviewDiffFileRows(
      [
        { path: "src/plain.ts", insertions: 1, deletions: 1 },
        { path: "src/foo bar.ts", insertions: 1, deletions: 1 },
      ],
      MIXED_PATCH,
    );

    expect(rows.map((row) => row.path)).toEqual(["src/plain.ts", "src/foo bar.ts"]);
    expect(rows[1]?.patchText).toContain("+new spaced");
  });

  it("parses quoted git paths with spaces", () => {
    expect(splitUnifiedDiffByFile(QUOTED_PATCH).map((section) => section.path)).toEqual([
      "src/quoted file.ts",
    ]);

    const rows = buildReviewDiffFileRows(
      [{ path: "src/quoted file.ts", insertions: 1, deletions: 1 }],
      QUOTED_PATCH,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.patchText).toContain("+new quoted");
  });

  it("parses quoted paths with escaped quotes", () => {
    expect(splitUnifiedDiffByFile(ESCAPED_QUOTED_PATCH).map((section) => section.path)).toEqual([
      'src/file"quote.ts',
    ]);

    const rows = buildReviewDiffFileRows(
      [{ path: 'src/file"quote.ts', insertions: 1, deletions: 1 }],
      ESCAPED_QUOTED_PATCH,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.patchText).toContain("+new escaped");
  });

  it("does not misparse unquoted paths that contain a literal b segment", () => {
    expect(splitUnifiedDiffByFile(LITERAL_B_SEGMENT_PATCH).map((section) => section.path)).toEqual([
      "dir/ b/name.txt",
    ]);

    const rows = buildReviewDiffFileRows(
      [{ path: "dir/ b/name.txt", insertions: 1, deletions: 1 }],
      LITERAL_B_SEGMENT_PATCH,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.patchText).toContain("+new literal");
  });

  it("decodes git octal-quoted UTF-8 paths", () => {
    expect(splitUnifiedDiffByFile(OCTAL_QUOTED_PATCH).map((section) => section.path)).toEqual([
      "src/café.ts",
    ]);

    const rows = buildReviewDiffFileRows(
      [{ path: "src/café.ts", insertions: 1, deletions: 1 }],
      OCTAL_QUOTED_PATCH,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.patchText).toContain("+new octal");
  });

  it("matches rename sections by the new path", () => {
    expect(splitUnifiedDiffByFile(RENAME_PATCH).map((section) => section.path)).toEqual([
      "dst/after name.ts",
    ]);

    const rows = buildReviewDiffFileRows(
      [{ path: "dst/after name.ts", insertions: 0, deletions: 0, status: "renamed" }],
      RENAME_PATCH,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.patchText).toContain("rename to dst/after name.ts");
  });
});
