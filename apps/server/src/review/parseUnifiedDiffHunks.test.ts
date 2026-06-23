import { describe, expect, it } from "vitest";

import { parseUnifiedDiffHunks, subPatchForHunks } from "./parseUnifiedDiffHunks.ts";

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
});

describe("subPatchForHunks", () => {
  it("reconstructs a valid patch with only the referenced hunks", () => {
    const sub = subPatchForHunks(MODIFIED, [{ filePath: "src/app.ts", oldStart: 20 }]);
    expect(sub).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(sub).toContain("@@ -20,3 +21,3 @@");
    expect(sub).not.toContain("@@ -1,4 +1,5 @@");
    expect(sub).toContain("+  return 1;");
  });

  it("round-trips through the parser (sub-patch re-parses to the selected hunk)", () => {
    const sub = subPatchForHunks(`${MODIFIED}\n${ADDED}`, [
      { filePath: "src/app.ts", oldStart: 1 },
      { filePath: "src/new.ts", oldStart: 0 },
    ]);
    const reparsed = parseUnifiedDiffHunks(sub);
    expect(reparsed.map((f) => f.path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(reparsed[0]?.hunks).toHaveLength(1);
    expect(reparsed[0]?.hunks[0]?.oldStart).toBe(1);
  });

  it("returns empty string when no refs match", () => {
    expect(subPatchForHunks(MODIFIED, [{ filePath: "nope.ts", oldStart: 1 }])).toBe("");
  });
});
