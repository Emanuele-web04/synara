import { describe, expect, it } from "vitest";

import { parseUnifiedDiffHunks } from "./parseUnifiedDiffHunks.ts";

const MODIFIED = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -20,3 +21,3 @@",
  " function tail() {",
  "-  return 0;",
  "+  return 1;",
  " }",
].join("\n");

const ADDED = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const x = 1;",
  "+export const y = 2;",
].join("\n");

const QUOTED_SPACE = [
  'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
  "index 1111111..2222222 100644",
  '--- "a/src/foo bar.ts"',
  '+++ "b/src/foo bar.ts"',
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

const QUOTED_DELETED = [
  'diff --git "a/src/gone file.ts" "b/src/gone file.ts"',
  "deleted file mode 100644",
  "index 1111111..0000000 100644",
  '--- "a/src/gone file.ts"',
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-line one",
  "-line two",
].join("\n");

const PATH_WITH_B_SLASH = [
  "diff --git a/lib b/util.ts b/lib b/util.ts",
  "index 1111111..2222222 100644",
  "--- a/lib b/util.ts",
  "+++ b/lib b/util.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

const COPIED = [
  "diff --git a/src/orig.ts b/src/copy.ts",
  "similarity index 100%",
  "copy from src/orig.ts",
  "copy to src/copy.ts",
].join("\n");

describe("parseUnifiedDiffHunks", () => {
  it("returns [] for empty input", () => {
    expect(parseUnifiedDiffHunks("")).toEqual([]);
  });

  it("parses two hunks of a modified file with correct ranges", () => {
    const [file] = parseUnifiedDiffHunks(MODIFIED);
    expect(file?.path).toBe("src/app.ts");
    expect(file?.status).toBe("modified");
    expect(file?.hunks).toHaveLength(2);
    const [first, second] = file!.hunks;
    expect(first).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
    expect(first?.lines).toContain("+const c = 4;");
    expect(second).toMatchObject({ oldStart: 20, oldLines: 3, newStart: 21, newLines: 3 });
  });

  it("defaults omitted hunk line counts to 1", () => {
    const patch = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -5 +5 @@", "-old", "+new"].join(
      "\n",
    );
    const hunk = parseUnifiedDiffHunks(patch)[0]?.hunks[0];
    expect(hunk).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  });

  it("marks added files with oldStart 0 and status added", () => {
    const [file] = parseUnifiedDiffHunks(ADDED);
    expect(file?.path).toBe("src/new.ts");
    expect(file?.status).toBe("added");
    expect(file?.hunks[0]?.oldStart).toBe(0);
  });

  it("separates hunks across multiple files", () => {
    const files = parseUnifiedDiffHunks(`${MODIFIED}\n${ADDED}`);
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "src/new.ts"]);
  });

  it("unquotes a quoted modified path", () => {
    const [file] = parseUnifiedDiffHunks(QUOTED_SPACE);
    expect(file?.path).toBe("src/foo bar.ts");
    expect(file?.oldPath).toBe("src/foo bar.ts");
    expect(file?.hunks).toHaveLength(1);
  });

  it("recovers a quoted deleted file's path from the --- line", () => {
    const [file] = parseUnifiedDiffHunks(QUOTED_DELETED);
    expect(file?.path).toBe("src/gone file.ts");
    expect(file?.oldPath).toBe("src/gone file.ts");
    expect(file?.status).toBe("deleted");
    expect(file?.hunks).toHaveLength(1);
  });

  it("resolves a path containing ' b/' via the +++/--- lines", () => {
    const [file] = parseUnifiedDiffHunks(PATH_WITH_B_SLASH);
    expect(file?.path).toBe("lib b/util.ts");
    expect(file?.oldPath).toBe("lib b/util.ts");
    expect(file?.hunks).toHaveLength(1);
  });

  it("detects copied files via copy from/copy to", () => {
    const [file] = parseUnifiedDiffHunks(COPIED);
    expect(file?.path).toBe("src/copy.ts");
    expect(file?.oldPath).toBe("src/orig.ts");
    expect(file?.status).toBe("copied");
  });

  it("skips hunks with out-of-range header numbers", () => {
    const patch = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -99999999999999999999 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(parseUnifiedDiffHunks(patch)[0]?.hunks).toHaveLength(0);
  });
});
