import { describe, expect, it } from "vitest";

import type { ReviewWalkthroughChapter } from "@t3tools/contracts";

import { parseUnifiedDiffHunks } from "./parseUnifiedDiffHunks.ts";
import { formatHunksSummary, reconcileChapterCoverage } from "./walkthroughHunks.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  "@@ -20,2 +21,2 @@",
  "-const old = 1;",
  "+const next = 1;",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -5,1 +5,2 @@",
  " const d = 4;",
  "+const e = 5;",
].join("\n");

const FILES = parseUnifiedDiffHunks(PATCH);

function chapter(overrides: Partial<ReviewWalkthroughChapter>): ReviewWalkthroughChapter {
  return {
    id: "chapter-1",
    title: "A chapter",
    summary: "Summary.",
    intent: "Why it matters.",
    anchor: "anchor",
    risk: "minor",
    hunkRefs: [],
    files: [],
    status: "queued",
    ...overrides,
  };
}

describe("formatHunksSummary", () => {
  it("lists every hunk as 'path | oldStart'", () => {
    expect(formatHunksSummary(FILES)).toBe(
      ["src/a.ts | 1", "src/a.ts | 20", "src/b.ts | 5"].join("\n"),
    );
  });
});

describe("reconcileChapterCoverage", () => {
  it("keeps a fully-covering chapter set unchanged, with no warnings", () => {
    const result = reconcileChapterCoverage(FILES, [
      chapter({
        id: "chapter-1",
        hunkRefs: [
          { filePath: "src/a.ts", oldStart: 1 },
          { filePath: "src/a.ts", oldStart: 20 },
        ],
      }),
      chapter({ id: "chapter-2", hunkRefs: [{ filePath: "src/b.ts", oldStart: 5 }] }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0]?.files).toEqual(["src/a.ts"]);
  });

  it("drops hunk refs that don't exist in the diff", () => {
    const result = reconcileChapterCoverage(FILES, [
      chapter({
        hunkRefs: [
          { filePath: "src/a.ts", oldStart: 1 },
          { filePath: "src/a.ts", oldStart: 999 },
        ],
      }),
    ]);
    expect(result.warnings.some((w) => w.includes("999"))).toBe(true);
    expect(result.chapters[0]?.hunkRefs).toHaveLength(1);
  });

  it("drops a hunk claimed by two chapters from the second one", () => {
    const result = reconcileChapterCoverage(FILES, [
      chapter({ id: "chapter-1", hunkRefs: [{ filePath: "src/a.ts", oldStart: 1 }] }),
      chapter({ id: "chapter-2", hunkRefs: [{ filePath: "src/a.ts", oldStart: 1 }] }),
    ]);
    expect(result.warnings.some((w) => w.includes("duplicate"))).toBe(true);
    expect(result.chapters.find((c) => c.id === "chapter-2")).toBeUndefined();
  });

  it("sweeps uncovered hunks into a trailing 'Other changes' chapter", () => {
    const result = reconcileChapterCoverage(FILES, [
      chapter({ hunkRefs: [{ filePath: "src/a.ts", oldStart: 1 }] }),
    ]);
    const other = result.chapters.at(-1);
    expect(other?.id).toBe("chapter-other");
    expect(other?.hunkRefs).toHaveLength(2);
    expect([...(other?.files ?? [])].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.warnings.some((w) => w.includes("Other changes"))).toBe(true);
  });
});
