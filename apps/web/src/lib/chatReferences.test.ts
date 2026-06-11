// FILE: chatReferences.test.ts
// Purpose: Guards reference formatting and selection line-range math for chat references.
// Layer: Web UI utility tests

import { describe, expect, it } from "vitest";

import {
  buildDiffSelectionReference,
  buildWhyChangedPrompt,
  buildWhyLinesPrompt,
  computeSelectionLineRange,
  formatChatFileReference,
} from "./chatReferences";

describe("formatChatFileReference", () => {
  it("formats a bare file reference as a mention token", () => {
    expect(formatChatFileReference({ path: "apps/web/src/main.tsx" })).toBe(
      "@apps/web/src/main.tsx",
    );
  });

  it("quotes paths containing whitespace", () => {
    expect(formatChatFileReference({ path: "docs/release notes.md" })).toBe(
      '@"docs/release notes.md"',
    );
  });

  it("appends a single-line suffix", () => {
    expect(formatChatFileReference({ path: "src/a.ts", startLine: 12 })).toBe(
      "@src/a.ts (line 12)",
    );
  });

  it("appends a line-range suffix", () => {
    expect(formatChatFileReference({ path: "src/a.ts", startLine: 3, endLine: 9 })).toBe(
      "@src/a.ts (lines 3-9)",
    );
  });
});

describe("buildWhyChangedPrompt", () => {
  it("mentions the file inside the question", () => {
    expect(buildWhyChangedPrompt("src/a.ts")).toBe(
      "Why did we implement the changes in @src/a.ts?",
    );
  });
});

describe("buildWhyLinesPrompt", () => {
  it("asks about the whole file without a line range", () => {
    expect(buildWhyLinesPrompt({ path: "src/a.ts" })).toContain("@src/a.ts");
    expect(buildWhyLinesPrompt({ path: "src/a.ts" })).not.toContain("lines");
  });

  it("asks about the selected line range", () => {
    const prompt = buildWhyLinesPrompt({ path: "src/a.ts", startLine: 3, endLine: 9 });
    expect(prompt).toContain("lines 3-9");
    expect(prompt).toContain("@src/a.ts");
    expect(prompt).toContain("git blame");
  });
});

describe("buildDiffSelectionReference", () => {
  it("wraps the snippet in a fenced block after the mention", () => {
    expect(buildDiffSelectionReference("src/a.ts", "const a = 1;\nconst b = 2;")).toBe(
      "@src/a.ts\n```\nconst a = 1;\nconst b = 2;\n```",
    );
  });

  it("normalizes CRLF and trims surrounding blank lines", () => {
    expect(buildDiffSelectionReference("src/a.ts", "\r\nfoo\r\nbar\r\n")).toBe(
      "@src/a.ts\n```\nfoo\nbar\n```",
    );
  });

  it("truncates very long snippets", () => {
    const longSnippet = "x".repeat(10_000);
    const result = buildDiffSelectionReference("src/a.ts", longSnippet);
    expect(result.length).toBeLessThan(5_000);
  });

  it("extends the fence when the snippet contains backtick fences", () => {
    expect(buildDiffSelectionReference("docs/a.md", "```ts\nconst a = 1;\n```")).toBe(
      "@docs/a.md\n````\n```ts\nconst a = 1;\n```\n````",
    );
  });
});

describe("computeSelectionLineRange", () => {
  it("starts at line 1 with an empty prefix", () => {
    expect(computeSelectionLineRange("", "const x = 1;")).toEqual({ startLine: 1, endLine: 1 });
  });

  it("offsets the start line by prefix newlines", () => {
    expect(computeSelectionLineRange("a\nb\nc\n", "selected")).toEqual({
      startLine: 4,
      endLine: 4,
    });
  });

  it("spans multi-line selections", () => {
    expect(computeSelectionLineRange("a\n", "line one\nline two\nline three")).toEqual({
      startLine: 2,
      endLine: 4,
    });
  });

  it("ignores trailing newlines in the selection", () => {
    expect(computeSelectionLineRange("", "line one\nline two\n")).toEqual({
      startLine: 1,
      endLine: 2,
    });
  });
});
