import { describe, expect, it } from "vitest";
import i18n from "~/i18n";

describe("i18n initialization", () => {
  it("has en and zh-CN as available languages", () => {
    const languages = Object.keys(i18n.options.resources ?? {});
    expect(languages).toContain("en");
    expect(languages).toContain("zh-CN");
  });

  it("returns the key when translation is missing (fallback)", () => {
    const result = i18n.t("nonexistent.key");
    expect(result).toBe("nonexistent.key");
  });

  it("translates common keys correctly in current language", () => {
    const currentLang = i18n.language;
    if (currentLang === "zh-CN") {
      expect(i18n.t("common.save")).toBe("保存");
    } else {
      expect(i18n.t("common.save")).toBe("Save");
    }
  });

  it("can switch language at runtime", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("common.cancel")).toBe("取消");

    await i18n.changeLanguage("en");
    expect(i18n.t("common.cancel")).toBe("Cancel");

    // 恢复原语言
    const originalLang = import.meta.env.VITE_LOCALE || "en";
    await i18n.changeLanguage(originalLang);
  });
});
