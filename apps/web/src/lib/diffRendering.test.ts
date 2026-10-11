// FILE: diffRendering.test.ts
// Purpose: Verifies shared git patch helpers used by diff chrome and header badges.
// Layer: Web diff utility tests
// Depends on: Vitest and diffRendering helpers

import { describe, expect, it } from "vitest";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  fileDiffStatsByPath,
  getRenderablePatch,
  hasUneditableGitMode,
  resolveDiffCopyText,
  PARTIAL_DIFF_COPY_NOTICE,
  resolveFileDiffStatByChangedPath,
  resolveFileDiffPath,
  resolveFileDiffPrevPath,
  sortFileDiffsByPath,
  splitPatchIntoFileSegments,
  splitRepoRelativePath,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

const FILE_A_PATCH = [
  "diff --git a/a.ts b/a.ts",
  "index 0000001..0000002 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " const shared = 1;",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

const FILE_B_PATCH = [
  "diff --git a/b.ts b/b.ts",
  "index 0000003..0000004 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,1 +1,2 @@",
  " const b = 1;",
  "+const added = 2;",
].join("\n");

const FILE_B_PATCH_EDITED = FILE_B_PATCH.replace("const added = 2;", "const added = 3;");

describe("splitPatchIntoFileSegments", () => {
  it("keeps leading metadata attached to the first segment", () => {
    const segments = splitPatchIntoFileSegments(`commit message\n${FILE_A_PATCH}\n${FILE_B_PATCH}`);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("commit message");
  });
});

describe("getRenderablePatch per-file cache keys", () => {
  it("keeps a file's render key stable when another file changes", () => {
    const before = getRenderablePatch(`${FILE_A_PATCH}\n${FILE_B_PATCH}`);
    const after = getRenderablePatch(`${FILE_A_PATCH}\n${FILE_B_PATCH_EDITED}`);
    if (before?.kind !== "files" || after?.kind !== "files") {
      throw new Error("expected parsed files");
    }

    const keyOf = (renderable: typeof before, path: string) => {
      const file = renderable.files.find((candidate) => resolveFileDiffPath(candidate) === path);
      if (!file) throw new Error(`missing ${path}`);
      return buildFileDiffRenderKey(file);
    };

    expect(keyOf(after, "a.ts")).toBe(keyOf(before, "a.ts"));
    expect(keyOf(after, "b.ts")).not.toBe(keyOf(before, "b.ts"));
  });
});

describe("resolveDiffCopyText", () => {
  it("preserves every line of a large patch without depending on mounted rows", () => {
    const bodyLines = Array.from({ length: 6000 }, (_, index) => `+line ${index + 1}`);
    const patch = [
      "diff --git a/big.txt b/big.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/big.txt",
      "@@ -0,0 +1,6000 @@",
      ...bodyLines,
      "",
    ].join("\n");

    expect(resolveDiffCopyText(patch)).toBe(patch);
  });

  it("marks truncated clipboard content as a partial diff", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+partial  ";

    expect(resolveDiffCopyText(patch, true)).toBe(`${patch}\n\n${PARTIAL_DIFF_COPY_NOTICE}\n`);
  });

  it("does not expose empty or missing patches as copyable", () => {
    expect(resolveDiffCopyText(undefined)).toBeNull();
    expect(resolveDiffCopyText(" \n\t ")).toBeNull();
  });
});

describe("resolveFileDiffPrevPath", () => {
  const parseSingleFile = (patch: string) => {
    const renderable = getRenderablePatch(patch, "prev-path:test");
    if (renderable?.kind !== "files" || renderable.files.length !== 1) {
      throw new Error("expected one parsed file");
    }
    return renderable.files[0]!;
  };

  it("returns the old path only for renamed files", () => {
    const renamed = parseSingleFile(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 80%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "index 1111111..2222222 100644",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        "@@ -1,1 +1,1 @@",
        "-const value = 1;",
        "+const value = 2;",
        "",
      ].join("\n"),
    );
    expect(resolveFileDiffPath(renamed)).toBe("src/new.ts");
    expect(resolveFileDiffPrevPath(renamed)).toBe("src/old.ts");
  });

  it("reports no old path for added files, whose base side does not exist", () => {
    const added = parseSingleFile(
      [
        "diff --git a/src/added.ts b/src/added.ts",
        "new file mode 100644",
        "index 0000000..2222222",
        "--- /dev/null",
        "+++ b/src/added.ts",
        "@@ -0,0 +1,1 @@",
        "+const value = 1;",
        "",
      ].join("\n"),
    );
    expect(added.type).toBe("new");
    expect(resolveFileDiffPrevPath(added)).toBeNull();
  });

  it("reports no old path for in-place edits", () => {
    const changed = parseSingleFile(
      [
        "diff --git a/src/one.ts b/src/one.ts",
        "index 1111111..2222222 100644",
        "--- a/src/one.ts",
        "+++ b/src/one.ts",
        "@@ -1,1 +1,1 @@",
        "-const one = 1;",
        "+const one = 2;",
        "",
      ].join("\n"),
    );
    expect(resolveFileDiffPrevPath(changed)).toBeNull();
  });
});

describe("hasUneditableGitMode", () => {
  const parseSingleFile = (patch: string) => {
    const renderable = getRenderablePatch(patch, "symlink:test");
    if (renderable?.kind !== "files" || renderable.files.length !== 1) {
      throw new Error("expected one parsed file");
    }
    return renderable.files[0]!;
  };

  it("recognizes changed and added symlinks by their git mode", () => {
    const changed = parseSingleFile(
      [
        "diff --git a/link b/link",
        "index 1111111..2222222 120000",
        "--- a/link",
        "+++ b/link",
        "@@ -1 +1 @@",
        "-old-target",
        "\\ No newline at end of file",
        "+new-target",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(hasUneditableGitMode(changed)).toBe(true);
    const added = parseSingleFile(
      [
        "diff --git a/link b/link",
        "new file mode 120000",
        "index 0000000..2222222",
        "--- /dev/null",
        "+++ b/link",
        "@@ -0,0 +1 @@",
        "+target",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(hasUneditableGitMode(added)).toBe(true);
  });

  it("recognizes submodule entries by their gitlink mode", () => {
    const submodule = parseSingleFile(
      [
        "diff --git a/vendor/lib b/vendor/lib",
        "index 1111111..2222222 160000",
        "--- a/vendor/lib",
        "+++ b/vendor/lib",
        "@@ -1 +1 @@",
        "-Subproject commit 1111111111111111111111111111111111111111",
        "+Subproject commit 2222222222222222222222222222222222222222",
        "",
      ].join("\n"),
    );
    expect(hasUneditableGitMode(submodule)).toBe(true);
  });

  it("treats regular files as editable", () => {
    const regular = parseSingleFile(
      [
        "diff --git a/src/one.ts b/src/one.ts",
        "index 1111111..2222222 100644",
        "--- a/src/one.ts",
        "+++ b/src/one.ts",
        "@@ -1,1 +1,1 @@",
        "-const one = 1;",
        "+const one = 2;",
        "",
      ].join("\n"),
    );
    expect(hasUneditableGitMode(regular)).toBe(false);
  });
});

describe("file diff identity helpers", () => {
  const twoFilePatch = [
    "diff --git a/src/one.ts b/src/one.ts",
    "index 1111111..2222222 100644",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1,1 +1,1 @@",
    "-const one = 1;",
    "+const one = 2;",
    "diff --git a/src/two.ts b/src/two.ts",
    "index 3333333..4444444 100644",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -1,1 +1,1 @@",
    "-const two = 1;",
    "+const two = 2;",
    "",
  ].join("\n");

  it("derives a unique, stable render key per file", () => {
    const renderable = getRenderablePatch(twoFilePatch, "git-pane:test");
    expect(renderable?.kind).toBe("files");
    if (renderable?.kind !== "files") return;

    const keys = renderable.files.map((file) => buildFileDiffRenderKey(file));
    expect(new Set(keys).size).toBe(keys.length);
    // Re-parsing the same patch yields the same identity for selection persistence.
    const reparsed = getRenderablePatch(twoFilePatch, "git-pane:test");
    if (reparsed?.kind !== "files") return;
    expect(reparsed.files.map((file) => buildFileDiffRenderKey(file))).toEqual(keys);
  });

  it("keeps binary image diffs as renderable file rows", () => {
    const patch = [
      "diff --git a/assets/screenshot.png b/assets/screenshot.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/screenshot.png and b/assets/screenshot.png differ",
      "",
    ].join("\n");

    const renderable = getRenderablePatch(patch, "git-pane:binary-image");
    expect(renderable?.kind).toBe("files");
    if (renderable?.kind !== "files") return;

    expect(renderable.files).toHaveLength(1);
    const [file] = renderable.files;
    expect(file).toBeDefined();
    if (!file) return;
    expect(resolveFileDiffPath(file)).toBe("assets/screenshot.png");
    expect(file.hunks).toEqual([]);
  });
});

describe("splitRepoRelativePath", () => {
  it("splits a nested path into a trailing-slash dir and leaf name", () => {
    expect(splitRepoRelativePath("src/components/Foo.tsx")).toEqual({
      dir: "src/components/",
      name: "Foo.tsx",
    });
  });

  it("treats a bare filename as having no directory", () => {
    expect(splitRepoRelativePath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("sortFileDiffsByPath", () => {
  const outOfOrderPatch = [
    "diff --git a/src/zebra.ts b/src/zebra.ts",
    "index 1111111..2222222 100644",
    "--- a/src/zebra.ts",
    "+++ b/src/zebra.ts",
    "@@ -1,1 +1,1 @@",
    "-const z = 1;",
    "+const z = 2;",
    "diff --git a/src/item10.ts b/src/item10.ts",
    "index 3333333..4444444 100644",
    "--- a/src/item10.ts",
    "+++ b/src/item10.ts",
    "@@ -1,1 +1,1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "diff --git a/src/item2.ts b/src/item2.ts",
    "index 5555555..6666666 100644",
    "--- a/src/item2.ts",
    "+++ b/src/item2.ts",
    "@@ -1,1 +1,1 @@",
    "-const b = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  it("orders files by natural path order without mutating the input", () => {
    const renderable = getRenderablePatch(outOfOrderPatch, "git-pane:sort");
    expect(renderable?.kind).toBe("files");
    if (renderable?.kind !== "files") return;

    const original = [...renderable.files];
    const sorted = sortFileDiffsByPath(renderable.files);

    // Numeric-aware ordering keeps item2 before item10, and the input is untouched.
    expect(sorted.map((file) => resolveFileDiffPath(file))).toEqual([
      "src/item2.ts",
      "src/item10.ts",
      "src/zebra.ts",
    ]);
    expect(renderable.files).toEqual(original);
  });
});

describe("fileDiffStatsByPath", () => {
  it("builds per-file stats from a parsed patch", () => {
    const patch = [
      "diff --git a/src/one.ts b/src/one.ts",
      "index 1111111..2222222 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,2 +1,2 @@",
      "-const one = 1;",
      "+const one = 2;",
      " const stable = true;",
      "diff --git a/src/two.ts b/src/two.ts",
      "index 3333333..4444444 100644",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -0,0 +1,2 @@",
      "+const two = 2;",
      "+export { two };",
      "",
    ].join("\n");

    expect(fileDiffStatsByPath(patch)).toEqual(
      new Map([
        ["src/one.ts", { additions: 1, deletions: 1 }],
        ["src/two.ts", { additions: 2, deletions: 0 }],
      ]),
    );
  });
});

describe("resolveFileDiffStatByChangedPath", () => {
  it("matches absolute changed-file paths to repo-relative patch stats", () => {
    const stat = { additions: 2, deletions: 1 };
    const statsByPath = new Map([["apps/web/src/App.tsx", stat]]);

    expect(
      resolveFileDiffStatByChangedPath(
        statsByPath,
        "/Users/example/project/apps/web/src/App.tsx",
        2,
      ),
    ).toBe(stat);
  });

  it("does not reuse a sole parsed stat across unrelated files in a multi-file row", () => {
    const statsByPath = new Map([["src/only-patched.ts", { additions: 3, deletions: 0 }]]);

    expect(resolveFileDiffStatByChangedPath(statsByPath, "src/unrelated.ts", 2)).toBeUndefined();
  });

  it("keeps the single-file fallback when the visible row also has one changed file", () => {
    const stat = { additions: 1, deletions: 4 };
    const statsByPath = new Map([["src/generated-name.ts", stat]]);

    expect(resolveFileDiffStatByChangedPath(statsByPath, "provider-reported-name.ts", 1)).toBe(
      stat,
    );
  });

  it("avoids ambiguous basename matches", () => {
    const statsByPath = new Map([
      ["src/a/index.ts", { additions: 1, deletions: 0 }],
      ["src/b/index.ts", { additions: 0, deletions: 1 }],
    ]);

    expect(resolveFileDiffStatByChangedPath(statsByPath, "index.ts", 2)).toBeUndefined();
  });
});
