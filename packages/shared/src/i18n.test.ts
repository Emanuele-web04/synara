// FILE: i18n.test.ts
// Purpose: Verifies the locale-aware helper used by pluralize and other text utilities.
// Layer: Shared runtime utility tests

import { describe, expect, it, vi } from "vitest";
import { isChineseLocale } from "./i18n";

describe("isChineseLocale", () => {
  it("returns a boolean", () => {
    expect(typeof isChineseLocale()).toBe("boolean");
  });

  it("returns false when VITE_LOCALE is undefined (default)", () => {
    // In the test environment, import.meta.env.VITE_LOCALE is not set,
    // so the function returns false (English default).
    expect(isChineseLocale()).toBe(false);
  });

  it("returns true when VITE_LOCALE is zh-CN", () => {
    vi.stubEnv("VITE_LOCALE", "zh-CN");
    expect(isChineseLocale()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("returns false for non-Chinese locales", () => {
    vi.stubEnv("VITE_LOCALE", "en-US");
    expect(isChineseLocale()).toBe(false);
    vi.unstubAllEnvs();
  });
});
