import { describe, expect, it } from "vitest";

import { normalizeLanguagePreference, resolveUiLocale } from "./uiLocale";

describe("interface locale resolution", () => {
  it("keeps Chinese inert on Stable while preserving supported System order and explicit languages", () => {
    expect(resolveUiLocale("zh-CN", ["zh-CN", "es-MX", "en-US"], "production")).toBe("es");
    expect(resolveUiLocale("system", ["zh-CN"], "production")).toBe("en");
    expect(resolveUiLocale("en", ["zh-CN", "es"], "production")).toBe("en");
    expect(resolveUiLocale("es", ["zh-CN", "en"], "production")).toBe("es");
    expect(resolveUiLocale("zh-CN", ["en-US"], "beta")).toBe("zh-CN");
    expect(resolveUiLocale("system", ["zh-CN"], "beta")).toBe("zh-CN");
  });

  it.each(["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-TW", "ZH-hans-sg"])(
    "resolves Simplified Chinese browser preference %s",
    (language) => {
      expect(resolveUiLocale("system", [language])).toBe("zh-CN");
    },
  );

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-CN"])(
    "does not silently map Traditional Chinese %s to Simplified Chinese",
    (language) => {
      expect(resolveUiLocale("system", [language, "es-MX", "en-US"])).toBe("es");
      expect(resolveUiLocale("system", [language])).toBe("en");
    },
  );

  it("respects browser preference order, explicit choices, and malformed language fallback", () => {
    expect(resolveUiLocale("system", ["fr-FR", "zh-Hans", "es-MX"])).toBe("zh-CN");
    expect(resolveUiLocale("system", ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveUiLocale("system", ["not_a_locale", "ES-es"])).toBe("es");
    expect(resolveUiLocale("system", [])).toBe("en");
    expect(resolveUiLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveUiLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveUiLocale("es", ["zh-CN"])).toBe("es");
  });

  it("accepts only persisted preference identifiers rather than arbitrary locale aliases", () => {
    for (const preference of ["system", "en", "es", "zh-CN"] as const)
      expect(normalizeLanguagePreference(preference)).toBe(preference);
    for (const value of [undefined, null, "zh", "zh-Hans", "zh-TW", "es-MX", "fr", 0, {}])
      expect(normalizeLanguagePreference(value)).toBe("system");
  });
});
