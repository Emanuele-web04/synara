import { describe, expect, it } from "vitest";

import { UI_LOCALES, normalizeLanguagePreference, resolveUiLocale } from "./uiLocale";

describe("interface locale resolution", () => {
  it("ships the DeltaMod Community interface languages", () => {
    expect(UI_LOCALES).toHaveLength(17);
  });

  it.each(["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-TW", "ZH-hans-sg"])(
    "resolves Simplified Chinese preference %s",
    (language) => {
      expect(resolveUiLocale("system", [language])).toBe("zh-CN");
    },
  );

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-CN"])(
    "maps Traditional Chinese %s to the Traditional Chinese catalog",
    (language) => {
      expect(resolveUiLocale("system", [language, "es-MX", "en-US"])).toBe(
        language === "zh-Hant-CN" ? "es-419" : "zh-TW",
      );
      expect(resolveUiLocale("system", [language])).toBe(
        language === "zh-Hant-CN" ? "en" : "zh-TW",
      );
    },
  );

  it("respects system preference order, regional variants, explicit choices, and malformed fallback", () => {
    expect(resolveUiLocale("system", ["fr-FR", "zh-Hans", "es-MX"])).toBe("fr");
    expect(resolveUiLocale("system", ["en-GB", "zh-CN"])).toBe("en");
    expect(resolveUiLocale("system", ["not_a_locale", "ES-es"])).toBe("es");
    expect(resolveUiLocale("system", ["ar-EG"])).toBe("ar");
    expect(resolveUiLocale("system", ["es-MX"])).toBe("es-419");
    expect(resolveUiLocale("system", [])).toBe("en");
    expect(resolveUiLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveUiLocale("pt-BR", ["en-US"])).toBe("pt-BR");
  });

  it("accepts only persisted preference identifiers rather than arbitrary locale aliases", () => {
    for (const preference of ["system", ...UI_LOCALES] as const)
      expect(normalizeLanguagePreference(preference)).toBe(preference);
    for (const value of [undefined, null, "zh", "zh-Hans", "es-MX", "pt", "hi", 0, {}])
      expect(normalizeLanguagePreference(value)).toBe("system");
  });
});
