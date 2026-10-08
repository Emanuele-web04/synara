// FILE: workspaceFileFind.logic.test.ts
// Purpose: Regression coverage for file-preview find matching and navigation.

import { describe, expect, it } from "vitest";

import {
  collectWorkspaceFileFindMatches,
  lineIndexForWorkspaceFileFindOffset,
  stepWorkspaceFileFindIndex,
  workspaceFileFindEnabled,
} from "./workspaceFileFind.logic";

describe("workspaceFileFindEnabled", () => {
  it.each([
    [
      "loaded read-only source",
      {
        fileContentsReady: true,
        fileIsImage: false,
        editableDocument: false,
        showMarkdownPreview: false,
      },
      true,
    ],
    [
      "editable source",
      {
        fileContentsReady: true,
        fileIsImage: false,
        editableDocument: true,
        showMarkdownPreview: false,
      },
      false,
    ],
    [
      "editable Markdown preview",
      {
        fileContentsReady: true,
        fileIsImage: false,
        editableDocument: true,
        showMarkdownPreview: true,
      },
      true,
    ],
    [
      "image preview",
      {
        fileContentsReady: true,
        fileIsImage: true,
        editableDocument: false,
        showMarkdownPreview: false,
      },
      false,
    ],
    [
      "loading source",
      {
        fileContentsReady: false,
        fileIsImage: false,
        editableDocument: false,
        showMarkdownPreview: false,
      },
      false,
    ],
  ] as const)("returns %s => %s", (_name, input, expected) => {
    expect(workspaceFileFindEnabled(input)).toBe(expected);
  });
});

describe("collectWorkspaceFileFindMatches", () => {
  it("matches case-insensitively without overlapping successive results", () => {
    expect(collectWorkspaceFileFindMatches("Error error ERROR", "error")).toEqual([
      { startOffset: 0, endOffset: 5 },
      { startOffset: 6, endOffset: 11 },
      { startOffset: 12, endOffset: 17 },
    ]);
    expect(collectWorkspaceFileFindMatches("aaaa", "aa")).toEqual([
      { startOffset: 0, endOffset: 2 },
      { startOffset: 2, endOffset: 4 },
    ]);
  });

  it("keeps original UTF-16 offsets after a character that expands when lowercased", () => {
    expect(collectWorkspaceFileFindMatches("İabc", "abc")).toEqual([
      { startOffset: 1, endOffset: 4 },
    ]);
    expect(collectWorkspaceFileFindMatches("İ\nabc", "abc")).toEqual([
      { startOffset: 2, endOffset: 5 },
    ]);
  });

  it("finds every literal occurrence of a character that expands when lowercased", () => {
    expect(collectWorkspaceFileFindMatches("İİ", "İ")).toEqual([
      { startOffset: 0, endOffset: 1 },
      { startOffset: 1, endOffset: 2 },
    ]);
  });

  it("uses Unicode case-insensitive matching without changing source offsets", () => {
    expect(collectWorkspaceFileFindMatches("ΟΣ οσ ος", "οσ")).toEqual([
      { startOffset: 0, endOffset: 2 },
      { startOffset: 3, endOffset: 5 },
      { startOffset: 6, endOffset: 8 },
    ]);
    expect(collectWorkspaceFileFindMatches("𐐀 𐐨", "𐐨")).toEqual([
      { startOffset: 0, endOffset: 2 },
      { startOffset: 3, endOffset: 5 },
    ]);
  });

  it("treats regex metacharacters as literal query text", () => {
    const literal = ".*+?^${}()|[]\\";
    expect(collectWorkspaceFileFindMatches(`prefix ${literal} suffix`, literal)).toEqual([
      { startOffset: 7, endOffset: 7 + literal.length },
    ]);
    expect(collectWorkspaceFileFindMatches("abc axc a.c", "a.c")).toEqual([
      { startOffset: 8, endOffset: 11 },
    ]);
  });

  it("ignores an empty or whitespace-only query", () => {
    expect(collectWorkspaceFileFindMatches("hello", "")).toEqual([]);
    expect(collectWorkspaceFileFindMatches("hello", "   ")).toEqual([]);
  });

  it("stops collecting once the caller's result cap is reached", () => {
    expect(collectWorkspaceFileFindMatches("a a a a", "a", 2)).toEqual([
      { startOffset: 0, endOffset: 1 },
      { startOffset: 2, endOffset: 3 },
    ]);
  });
});

describe("stepWorkspaceFileFindIndex", () => {
  it("wraps next and previous navigation", () => {
    expect(stepWorkspaceFileFindIndex(3, 0, "previous")).toBe(2);
    expect(stepWorkspaceFileFindIndex(3, 2, "next")).toBe(0);
    expect(stepWorkspaceFileFindIndex(0, 0, "next")).toBe(-1);
  });
});

describe("lineIndexForWorkspaceFileFindOffset", () => {
  it("resolves offsets to source lines and clamps out-of-range offsets", () => {
    expect(lineIndexForWorkspaceFileFindOffset("first\nsecond\nthird", 0)).toBe(0);
    expect(lineIndexForWorkspaceFileFindOffset("first\nsecond\nthird", 7)).toBe(1);
    expect(lineIndexForWorkspaceFileFindOffset("first\nsecond\nthird", 999)).toBe(2);
  });
});
