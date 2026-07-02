import { describe, expect, it } from "vitest";

import { appendCappedBufferedText } from "./ProviderRuntimeIngestion.ts";

describe("ProviderRuntimeIngestion buffered text helpers", () => {
  it("caps appended buffered text with a truncation marker", () => {
    const result = appendCappedBufferedText("abcdef", "ghijklmnopqrstuvwxyz", 20);

    expect(result).toBe("abcde... [truncated]");
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("keeps normal buffered text unchanged", () => {
    expect(appendCappedBufferedText("hello ", "world", 64)).toBe("hello world");
  });
});
