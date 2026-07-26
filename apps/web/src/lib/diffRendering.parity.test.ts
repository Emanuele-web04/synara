// FILE: diffRendering.parity.test.ts
// Purpose: Regression guard — the server-side patch counter must report exactly what the
//          browser reports after fully parsing the same patch.
// Layer: Web/shared contract test
//
// The `+N/-M` badge used to fetch the whole patch and count it here with
// `summarizePatchTotals`. It now asks the server for three integers instead, and the server
// counts with `summarizeUnifiedPatchTotals`. Those are two independent implementations
// feeding one badge, so any disagreement between them is a visible number changing for the
// user. Every patch shape git can emit for a working tree belongs in this table.

import { summarizeUnifiedPatchTotals } from "@synara/shared/unifiedPatchStats";
import { describe, expect, it } from "vitest";

import { summarizePatchTotals } from "./diffRendering";

const MODIFIED_FILE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const keep = 1;
-const removed = 2;
+const added = 2;
+const alsoAdded = 3;
 const tail = 4;
`;

const ADDED_FILE = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line one
+line two
+line three
`;

const DELETED_FILE = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
`;

// `git diff --no-index -- /dev/null <file>`, which is how the server folds untracked files in.
const UNTRACKED_VIA_NO_INDEX = `diff --git a/dev/null b/notes.md
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+# Notes
+Some text.
`;

const PURE_RENAME = `diff --git a/src/old.ts b/src/renamed.ts
similarity index 100%
rename from src/old.ts
rename to src/renamed.ts
`;

const RENAME_WITH_EDITS = `diff --git a/src/old.ts b/src/renamed.ts
similarity index 87%
rename from src/old.ts
rename to src/renamed.ts
index 6666666..7777777 100644
--- a/src/old.ts
+++ b/src/renamed.ts
@@ -1,3 +1,3 @@
 const untouched = 0;
-const before = 1;
+const after = 1;
`;

const BINARY_FILE = `diff --git a/assets/logo.png b/assets/logo.png
index 8888888..9999999 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

const NO_TRAILING_NEWLINE = `diff --git a/src/tail.ts b/src/tail.ts
index aaaaaaa..bbbbbbb 100644
--- a/src/tail.ts
+++ b/src/tail.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

// Content lines that themselves look like diff syntax. A counter that pattern-matches on
// `---`/`+++`/`diff --git` without tracking hunk boundaries miscounts every one of these.
const DIFF_SHAPED_CONTENT = `diff --git a/README.md b/README.md
index ccccccc..ddddddd 100644
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 Example patch:
-diff --git a/x b/x
---- a/x
-+++ b/x
+diff --git a/y b/y
+--- a/y
++++ b/y
 done
`;

const MULTI_HUNK = `diff --git a/src/multi.ts b/src/multi.ts
index eeeeeee..fffffff 100644
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1,3 +1,3 @@
 head
-a
+b
@@ -20,3 +20,4 @@ function context() {
 tail
-c
+d
+e
`;

const CASES: ReadonlyArray<readonly [name: string, patch: string]> = [
  ["a modified file", MODIFIED_FILE],
  ["an added file", ADDED_FILE],
  ["a deleted file", DELETED_FILE],
  ["an untracked file folded in via --no-index", UNTRACKED_VIA_NO_INDEX],
  ["a pure rename with no content change", PURE_RENAME],
  ["a rename with edits", RENAME_WITH_EDITS],
  ["a binary file", BINARY_FILE],
  ["a file with no trailing newline", NO_TRAILING_NEWLINE],
  ["content lines that look like diff headers", DIFF_SHAPED_CONTENT],
  ["multiple hunks in one file", MULTI_HUNK],
  [
    "every shape concatenated",
    [MODIFIED_FILE, ADDED_FILE, DELETED_FILE, PURE_RENAME, BINARY_FILE, MULTI_HUNK].join(""),
  ],
];

describe("server patch totals match the browser's parsed totals", () => {
  for (const [name, patch] of CASES) {
    it(`agrees on ${name}`, () => {
      expect(summarizeUnifiedPatchTotals(patch)).toEqual(summarizePatchTotals(patch));
    });
  }

  it("agrees that an empty patch has no totals", () => {
    for (const empty of ["", "   \n  ", undefined]) {
      expect(summarizeUnifiedPatchTotals(empty)).toEqual(summarizePatchTotals(empty));
    }
  });
});
