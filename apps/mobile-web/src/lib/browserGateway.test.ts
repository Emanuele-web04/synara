import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diffParser";

describe("mobile diff parsing", () => {
  it("creates safe read-only file and line summaries", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,2 +1,2 @@",
        "-const oldValue = 1;",
        "+const newValue = 2;",
        " unchanged();",
      ].join("\n"),
    );

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/example.ts",
      additions: 1,
      deletions: 1,
    });
    expect(files[0]?.lines.map((line) => line.kind)).toEqual([
      "context",
      "context",
      "header",
      "deletion",
      "addition",
      "context",
    ]);
  });
});
