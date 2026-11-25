import { describe, expect, it } from "vitest";

import { UI_LOCALES, normalizeLanguagePreference, resolveUiLocale } from "./uiLocale";

describe("interface locale resolution", () => {
  it("ships the ten target interface languages", () => {
    expect(UI_LOCALES).toEqual(["en", "zh-CN", "hi", "es", "fr", "ar", "bn", "pt", "ru", "ur"]);
  });

  it.each(["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-TW", "ZH-hans-sg"])(
    "resolves Simplified Chinese preference %s",
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

  it("respects system preference order, regional variants, explicit choices, and malformed fallback", () => {
    expect(resolveUiLocale("system", ["fr-FR", "zh-Hans", "es-MX"])).toBe("fr");
    expect(resolveUiLocale("system", ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveUiLocale("system", ["not_a_locale", "ES-es"])).toBe("es");
    expect(resolveUiLocale("system", ["ar-EG"])).toBe("ar");
    expect(resolveUiLocale("system", ["ur-PK"])).toBe("ur");
    expect(resolveUiLocale("system", [])).toBe("en");
    expect(resolveUiLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveUiLocale("pt", ["en-US"])).toBe("pt");
  });

  it("accepts only persisted preference identifiers rather than arbitrary locale aliases", () => {
    for (const preference of ["system", ...UI_LOCALES] as const)
      expect(normalizeLanguagePreference(preference)).toBe(preference);
    for (const value of [undefined, null, "zh", "zh-Hans", "zh-TW", "es-MX", "it", 0, {}])
      expect(normalizeLanguagePreference(value)).toBe("system");
  });
});
