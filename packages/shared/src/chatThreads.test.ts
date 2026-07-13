import { describe, expect, it } from "vitest";

import {
  buildPromptThreadTitleFallback,
  GENERIC_CHAT_THREAD_TITLE,
  isGenericChatThreadTitle,
  sanitizeGeneratedThreadTitle,
} from "./chatThreads";

describe("chatThreads", () => {
  it("builds a short fallback title without forcing case", () => {
    expect(buildPromptThreadTitleFallback("FIX the BROKEN auth redirect in production now")).toBe(
      "FIX the BROKEN auth redirect in",
    );
  });

  it("falls back to the generic thread title when there is no usable text", () => {
    expect(buildPromptThreadTitleFallback("   \n\t  ")).toBe(GENERIC_CHAT_THREAD_TITLE);
  });

  it("sanitizes generated titles without lowercasing acronyms", () => {
    expect(sanitizeGeneratedThreadTitle('"Folder picker UI ASAP."')).toBe("Folder picker UI ASAP");
  });

  it("keeps distinguishing identifiers within the six-word cap", () => {
    expect(sanitizeGeneratedThreadTitle("PR #1234 Conflict Review and more extra")).toBe(
      "PR #1234 Conflict Review and more",
    );
  });

  it("detects the generic chat placeholder title", () => {
    expect(isGenericChatThreadTitle(" New thread ")).toBe(true);
    expect(isGenericChatThreadTitle("Manual rename")).toBe(false);
  });
});
