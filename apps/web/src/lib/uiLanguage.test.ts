import { describe, expect, it } from "vitest";

import { resolveUiLanguage, translateUiText } from "./uiLanguage";

describe("uiLanguage", () => {
  it("follows a Chinese system language when the preference is system default", () => {
    expect(resolveUiLanguage("system", ["zh-CN", "en-US"])).toBe("zh-CN");
    expect(resolveUiLanguage("system", ["en-US"])).toBe("en");
  });

  it("honors an explicit language choice over the system language", () => {
    expect(resolveUiLanguage("en", ["zh-CN"])).toBe("en");
    expect(resolveUiLanguage("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("translates only fixed application chrome", () => {
    expect(translateUiText("zh-CN", "Language")).toBe("界面语言");
    expect(translateUiText("zh-CN", "A user message stays unchanged.")).toBe(
      "A user message stays unchanged.",
    );
    expect(translateUiText("en", "Language")).toBe("Language");
  });
});
