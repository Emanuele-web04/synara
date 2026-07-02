import { describe, expect, it } from "vitest";

import {
  appendPastedTextsToPrompt,
  createPastedTextDraft,
  extractTrailingPastedTexts,
  pastedTextTitle,
  shouldCollapsePastedText,
} from "./composerPastedText";

function makeDraft(id: string, text: string) {
  return createPastedTextDraft({ id, createdAt: "2026-06-15T00:00:00.000Z", text });
}

describe("shouldCollapsePastedText", () => {
  it("ignores short pastes", () => {
    expect(shouldCollapsePastedText("just a quick line")).toBe(false);
    expect(shouldCollapsePastedText("a\nb\nc")).toBe(false);
    expect(shouldCollapsePastedText("")).toBe(false);
  });

  it("collapses pastes past the line threshold", () => {
    const manyLines = Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n");
    expect(shouldCollapsePastedText(manyLines)).toBe(true);
  });

  it("collapses pastes past the character threshold", () => {
    expect(shouldCollapsePastedText("x".repeat(4000))).toBe(true);
    expect(shouldCollapsePastedText("x".repeat(3999))).toBe(false);
  });

  it("normalizes CRLF before measuring", () => {
    const manyLines = Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\r\n");
    expect(shouldCollapsePastedText(manyLines)).toBe(true);
  });
});

describe("createPastedTextDraft / pastedTextTitle", () => {
  it("computes metrics and a first-line title", () => {
    const draft = makeDraft("p1", "  \n  You are working on it\nmore text");
    expect(draft.lineCount).toBe(3);
    expect(draft.charCount).toBe(draft.text.length);
    expect(pastedTextTitle(draft.text)).toBe("You are working on it");
  });

  it("falls back to a generic title for whitespace-only content", () => {
    expect(pastedTextTitle("   \n\t")).toBe("Pasted text");
  });
});

describe("appendPastedTextsToPrompt / extractTrailingPastedTexts", () => {
  it("appends a trailing block and round-trips the content", () => {
    const message = appendPastedTextsToPrompt("Fix this:", [makeDraft("p1", "line one\nline two")]);

    expect(message.startsWith("Fix this:")).toBe(true);
    expect(message).toContain("<pasted_text>");

    const extracted = extractTrailingPastedTexts(message);
    expect(extracted.promptText).toBe("Fix this:");
    expect(extracted.pastedTexts).toEqual([
      { index: 1, text: "line one\nline two", lineCount: 2, charCount: 17 },
    ]);
  });

  it("sends a paste-only message as just the block", () => {
    const message = appendPastedTextsToPrompt("", [makeDraft("p1", "alpha\nbeta")]);
    const extracted = extractTrailingPastedTexts(message);
    expect(extracted.promptText).toBe("");
    expect(extracted.pastedTexts.map((entry) => entry.text)).toEqual(["alpha\nbeta"]);
  });

  it("preserves ordering and blank lines across multiple pastes", () => {
    const message = appendPastedTextsToPrompt("do it", [
      makeDraft("a", "first\n\nsecond"),
      makeDraft("b", "beta"),
    ]);
    const extracted = extractTrailingPastedTexts(message);
    expect(extracted.pastedTexts.map((entry) => entry.text)).toEqual(["first\n\nsecond", "beta"]);
  });

  it("round-trips content that looks like old delimiters or transport tags", () => {
    const pastedText = ["before", "[/#1]", "</pasted_text>", "after"].join("\n");
    const message = appendPastedTextsToPrompt("do it", [makeDraft("a", pastedText)]);
    const extracted = extractTrailingPastedTexts(message);

    expect(extracted.promptText).toBe("do it");
    expect(extracted.pastedTexts.map((entry) => entry.text)).toEqual([pastedText]);
  });

  it("returns the prompt untouched when there is no trailing block", () => {
    const extracted = extractTrailingPastedTexts("nothing to see here");
    expect(extracted.promptText).toBe("nothing to see here");
    expect(extracted.pastedTexts).toEqual([]);
  });
});
