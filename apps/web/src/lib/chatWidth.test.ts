import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_WIDTH, normalizeChatWidthMode } from "./chatWidth";

describe("chatWidth", () => {
  it("normalizes unknown values to the default mode", () => {
    expect(normalizeChatWidthMode("wide")).toBe("wide");
    expect(normalizeChatWidthMode("full")).toBe("full");
    expect(normalizeChatWidthMode("invalid")).toBe(DEFAULT_CHAT_WIDTH);
    expect(normalizeChatWidthMode(undefined)).toBe(DEFAULT_CHAT_WIDTH);
  });
});
