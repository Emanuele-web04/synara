import { describe, expect, it } from "vitest";

import { normalizeLanguagePreference, readLanguagePreference, resolveLocale } from "./locale";

describe("interface locale", () => {
  it("matches regional browser languages in preference order with English fallback", () => {
    expect(resolveLocale("system", ["fr-FR", "es-MX", "en-US"])).toBe("es");
    expect(resolveLocale("system", ["en-GB", "es-ES"])).toBe("en");
    expect(resolveLocale("system", ["ES-es"])).toBe("es");
    expect(resolveLocale("system", ["fr-FR"])).toBe("en");
    expect(resolveLocale("system", [])).toBe("en");
    expect(resolveLocale("es", ["en-US"])).toBe("es");
    expect(resolveLocale("en", ["es-ES"])).toBe("en");
  });

  it("normalizes unsupported preferences and reads only the existing settings record", () => {
    expect(normalizeLanguagePreference("es")).toBe("es");
    expect(normalizeLanguagePreference("en")).toBe("en");
    for (const invalid of [undefined, null, "es-MX", "fr", 0, {}]) {
      expect(normalizeLanguagePreference(invalid)).toBe("system");
    }
    for (const raw of [null, "invalid JSON", '"es"', "[]", '{"language":"fr"}']) {
      expect(readLanguagePreference({ getItem: () => raw })).toBe("system");
    }
    expect(readLanguagePreference({ getItem: () => '{"language":"es"}' })).toBe("es");
    expect(
      readLanguagePreference({
        getItem: () => {
          throw new Error("blocked storage");
        },
      }),
    ).toBe("system");
  });
});
