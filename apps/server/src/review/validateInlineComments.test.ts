import { describe, expect, it } from "vitest";

import type { ReviewInlineComment } from "@t3tools/contracts";
import { validateInlineComments } from "./validateInlineComments.ts";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,5 +1,6 @@",
  " const a = 1;",
  "-const stale = 2;",
  "+const fresh = 2;",
  "+const added = 3;",
  " const b = 4;",
  " const c = 5;",
  " const d = 6;",
  "",
].join("\n");

function comment(overrides: Partial<ReviewInlineComment>): ReviewInlineComment {
  return {
    path: "src/app.ts",
    line: 3,
    side: "RIGHT",
    body: "note",
    ...overrides,
  };
}

describe("validateInlineComments", () => {
  it("keeps a comment on an added RIGHT line", () => {
    const result = validateInlineComments(PATCH, [comment({ line: 3, side: "RIGHT" })]);
    expect(result.valid).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("drops a comment whose path is not in the diff", () => {
    const candidate = comment({ path: "src/other.ts", line: 3, side: "RIGHT" });
    const result = validateInlineComments(PATCH, [candidate]);
    expect(result.valid).toHaveLength(0);
    expect(result.skipped).toEqual([candidate]);
  });

  it("keeps a comment on a removed LEFT line", () => {
    const result = validateInlineComments(PATCH, [comment({ line: 2, side: "LEFT" })]);
    expect(result.valid).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("drops a comment on a line outside any hunk", () => {
    const candidate = comment({ line: 999, side: "RIGHT" });
    const result = validateInlineComments(PATCH, [candidate]);
    expect(result.valid).toHaveLength(0);
    expect(result.skipped).toEqual([candidate]);
  });

  it("keeps a comment on a context (unchanged) line on the RIGHT side", () => {
    // " const b = 4;" is a context line: right line 4, left line 3.
    const result = validateInlineComments(PATCH, [comment({ line: 4, side: "RIGHT" })]);
    expect(result.valid).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it("drops a comment valid on RIGHT but requested on the wrong (LEFT) side", () => {
    // The hunk nets +1 line, so the right side runs one line past the left.
    // Its highest right line is valid on RIGHT but has no matching LEFT line.
    const highestRight = 7;
    const wrongSide = comment({ line: highestRight, side: "LEFT" });
    expect(validateInlineComments(PATCH, [wrongSide]).skipped).toEqual([wrongSide]);
    expect(
      validateInlineComments(PATCH, [comment({ line: highestRight, side: "RIGHT" })]).valid,
    ).toHaveLength(1);
  });

  it("keeps a comment whose line lives in the second hunk of a multi-hunk file", () => {
    const multiHunk = [
      "diff --git a/src/multi.ts b/src/multi.ts",
      "index 1111111..2222222 100644",
      "--- a/src/multi.ts",
      "+++ b/src/multi.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      "@@ -20,3 +20,4 @@",
      " const x = 1;",
      "+const inserted = 2;",
      " const y = 3;",
      " const z = 4;",
      "",
    ].join("\n");
    // The inserted line is right line 21, inside the second hunk.
    const candidate: ReviewInlineComment = {
      path: "src/multi.ts",
      line: 21,
      side: "RIGHT",
      body: "note",
    };
    const result = validateInlineComments(multiHunk, [candidate]);
    expect(result.valid).toEqual([candidate]);
    expect(result.skipped).toHaveLength(0);
  });

  it("keeps renamed-file comments on the side-appropriate path", () => {
    const renamePatch = [
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
    const candidate: ReviewInlineComment = {
      path: "src/after.ts",
      line: 2,
      side: "RIGHT",
      body: "note",
    };
    const result = validateInlineComments(renamePatch, [candidate]);
    expect(result.valid).toEqual([candidate]);
    expect(result.skipped).toHaveLength(0);

    const oldPathLeft: ReviewInlineComment = {
      path: "src/before.ts",
      line: 2,
      side: "LEFT",
      body: "note",
    };
    expect(validateInlineComments(renamePatch, [oldPathLeft]).valid).toEqual([oldPathLeft]);

    const oldPathRight: ReviewInlineComment = { ...candidate, path: "src/before.ts" };
    expect(validateInlineComments(renamePatch, [oldPathRight]).skipped).toEqual([oldPathRight]);
  });

  it("keeps a LEFT comment on a deleted file's old path", () => {
    const deletePatch = [
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-const removed = 1;",
      "-const alsoRemoved = 2;",
      "",
    ].join("\n");
    const candidate: ReviewInlineComment = {
      path: "src/deleted.ts",
      line: 2,
      side: "LEFT",
      body: "note",
    };
    const result = validateInlineComments(deletePatch, [candidate]);
    expect(result.valid).toEqual([candidate]);
    expect(result.skipped).toHaveLength(0);
  });
});
