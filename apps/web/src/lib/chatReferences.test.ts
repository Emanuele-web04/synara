// FILE: chatReferences.test.ts
// Purpose: Guards reference formatting and selection line-range math for chat references.
// Layer: Web UI utility tests

import { describe, expect, it } from "vitest";

import {
  buildDiffSelectionReference,
  buildWhyLinesPrompt,
  computeSelectionColumns,
  computeSelectionLineRange,
  formatChatFileReference,
  normalizeSelectionSnippet,
} from "./chatReferences";

describe("formatChatFileReference", () => {
  it("quotes paths containing whitespace", () => {
    expect(formatChatFileReference({ path: "docs/release notes.md" })).toBe(
      '@"docs/release notes.md"',
    );
  });

  it("appends a line-range suffix", () => {
    expect(formatChatFileReference({ path: "src/a.ts", startLine: 3, endLine: 9 })).toBe(
      "@src/a.ts (lines 3-9)",
    );
  });

  it("appends a single-line column range", () => {
    expect(
      formatChatFileReference({
        path: "src/a.ts",
        startLine: 22,
        endLine: 22,
        startColumn: 5,
        endColumn: 12,
      }),
    ).toBe("@src/a.ts (line 22:5-12)");
  });

  it("collapses a single-character selection to one column", () => {
    expect(
      formatChatFileReference({
        path: "src/a.ts",
        startLine: 22,
        endLine: 22,
        startColumn: 5,
        endColumn: 5,
      }),
    ).toBe("@src/a.ts (line 22:5)");
  });

  it("appends a multi-line column range", () => {
    expect(
      formatChatFileReference({
        path: "src/a.ts",
        startLine: 21,
        endLine: 23,
        startColumn: 5,
        endColumn: 8,
      }),
    ).toBe("@src/a.ts (lines 21:5-23:8)");
  });

  it("prefers the line label over a snippet", () => {
    expect(
      formatChatFileReference({ path: "src/a.ts", startLine: 3, snippet: "const a = 1;" }),
    ).toBe("@src/a.ts (line 3)");
  });

  it("ignores whitespace-only snippets", () => {
    expect(formatChatFileReference({ path: "docs/notes.md", snippet: "  \n " })).toBe(
      "@docs/notes.md",
    );
  });
});

describe("computeSelectionColumns", () => {
  it("offsets the start column by characters before the selection on the line", () => {
    expect(computeSelectionColumns("a\nabc", "de")).toEqual({ startColumn: 4, endColumn: 5 });
  });

  it("ends on the final line for multi-line selections", () => {
    expect(computeSelectionColumns("x\nabc", "de\nfg")).toEqual({ startColumn: 4, endColumn: 2 });
  });

  it("ignores a trailing newline when computing the end column", () => {
    expect(computeSelectionColumns("", "hello\n")).toEqual({ startColumn: 1, endColumn: 5 });
  });
});

describe("buildWhyLinesPrompt", () => {
  it("asks about the selected line range", () => {
    const prompt = buildWhyLinesPrompt({ path: "src/a.ts", startLine: 3, endLine: 9 });
    expect(prompt).toContain("lines 3-9");
    expect(prompt).toContain("@src/a.ts");
    expect(prompt).toContain("git blame");
  });
});

describe("normalizeSelectionSnippet", () => {
  it("normalizes CRLF and strips blank edge lines and surrounding whitespace", () => {
    expect(normalizeSelectionSnippet("\r\n  first\r\nsecond  \r\n\r\n")).toBe("first\nsecond");
  });

  it("keeps interior blank lines", () => {
    expect(normalizeSelectionSnippet("first\n\nsecond")).toBe("first\n\nsecond");
  });

  it("returns null for empty or whitespace-only selections", () => {
    expect(normalizeSelectionSnippet("")).toBeNull();
    expect(normalizeSelectionSnippet(" \n\t\r\n ")).toBeNull();
  });
});

describe("buildDiffSelectionReference", () => {
  it("wraps the snippet in a fenced block after the mention", () => {
    expect(buildDiffSelectionReference("src/a.ts", "const a = 1;\nconst b = 2;")).toBe(
      "@src/a.ts\n```\nconst a = 1;\nconst b = 2;\n```",
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
