import { describe, expect, it } from "vitest";

import {
  buildPromptThreadTitleFallback,
  GENERIC_CHAT_THREAD_TITLE,
  isGenericChatThreadTitle,
  sanitizeGeneratedThreadTitle,
} from "./chatThreads";

describe("chatThreads", () => {
  it("builds a short fallback title in sentence case from the first four words", () => {
    expect(buildPromptThreadTitleFallback("FIX the BROKEN auth redirect in production now")).toBe(
      "Fix the broken auth",
    );
  });

  it("falls back to the generic thread title when there is no usable text", () => {
    expect(buildPromptThreadTitleFallback("   \n\t  ")).toBe(GENERIC_CHAT_THREAD_TITLE);
  });

  it("sanitizes generated titles down to four words in sentence case", () => {
    expect(sanitizeGeneratedThreadTitle('"Workspace Logic Check ASAP."')).toBe(
      "Workspace logic check",
    );
  });

  it("detects the generic chat placeholder title", () => {
    expect(isGenericChatThreadTitle(" New thread ")).toBe(true);
    expect(isGenericChatThreadTitle("Manual rename")).toBe(false);
  });
});
