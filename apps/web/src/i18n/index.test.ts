import { afterEach, describe, expect, it, vi } from "vitest";

import { getFormatLocale, initializeI18n, i18n, setLanguagePreference, t } from "./index";
import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";

afterEach(() => {
  vi.unstubAllGlobals();
  setLanguagePreference("system");
});

describe("bundled translations", () => {
  it("mirrors stored and changed preferences to a compatible native bridge", () => {
    const events = new EventTarget();
    const setNativePreference = vi.fn(async () => {});
    Object.assign(events, { desktopBridge: { setLanguagePreference: setNativePreference } });
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", { getItem: () => '{"language":"zh-CN"}' });
    const dispose = initializeI18n();
    try {
      expect(setNativePreference).toHaveBeenLastCalledWith("zh-CN");
      setLanguagePreference("en");
      expect(setNativePreference).toHaveBeenLastCalledWith("en");
      const count = setNativePreference.mock.calls.length;
      setLanguagePreference("en");
      expect(setNativePreference).toHaveBeenCalledTimes(count);
    } finally {
      dispose();
    }
  });

  it("resolves System from native preferences ahead of Chromium's default language", () => {
    vi.stubGlobal("window", {
      desktopBridge: { getSystemLanguages: () => ["zh-Hans-CN", "en-US"] },
    });
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    setLanguagePreference("system");
    expect(t("workspace:toast_settings")).toBe("设置");
    expect(getFormatLocale()).toBe("zh-CN");
  });

  it("refreshes native language candidates once when System changes, keeping document and renderer in sync", () => {
    const events = new EventTarget();
    let languages = ["en-US"];
    const getSystemLanguages = vi.fn(() => languages);
    const setNativePreference = vi.fn(async () => {});
    Object.assign(events, {
      desktopBridge: { getSystemLanguages, setLanguagePreference: setNativePreference },
    });
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("document", { documentElement: { lang: "", dir: "" } });
    const dispose = initializeI18n();
    try {
      expect(t("workspace:toast_settings")).toBe("Settings");
      getSystemLanguages.mockClear();
      languages = ["zh-Hans-CN"];
      events.dispatchEvent(new Event("languagechange"));
      expect(getSystemLanguages).toHaveBeenCalledTimes(1);
      expect(t("workspace:toast_settings")).toBe("设置");
      expect(document.documentElement.lang).toBe("zh-CN");
      expect(setNativePreference).toHaveBeenLastCalledWith("system");
      setLanguagePreference("en");
      expect(getSystemLanguages).toHaveBeenCalledTimes(1);
      expect(document.documentElement.lang).toBe("en");
    } finally {
      dispose();
    }
  });

  it("falls back to browser preferences when the native language bridge is unavailable", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getSystemLanguages: () => {
          throw new Error("bridge unavailable");
        },
      },
    });
    vi.stubGlobal("navigator", { languages: ["zh-CN"] });
    setLanguagePreference("system");
    expect(t("workspace:toast_settings")).toBe("设置");
  });

  it("retries the same native preference after a failed synchronization", async () => {
    const setNativePreference = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("window", { desktopBridge: { setLanguagePreference: setNativePreference } });
    try {
      setLanguagePreference("zh-CN");
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      setLanguagePreference("zh-CN");
      expect(setNativePreference).toHaveBeenCalledTimes(2);
      expect(t("workspace:toast_settings")).toBe("设置");
    } finally {
      warn.mockRestore();
    }
  });

  it("notifies System subscribers when the browser changes between Simplified Chinese regions", () => {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("navigator", { languages: ["zh-CN"] });
    const dispose = initializeI18n();
    const changed = vi.fn();
    i18n.on("languageChanged", changed);
    try {
      vi.stubGlobal("navigator", { languages: ["zh-SG"] });
      events.dispatchEvent(new Event("languagechange"));
      expect(changed).toHaveBeenCalledWith("zh-CN");
      expect(getFormatLocale()).toBe("zh-CN");
    } finally {
      i18n.off("languageChanged", changed);
      dispose();
    }
  });

  it("switches synchronously using shipped catalogs and falls back to English for unsupported System languages", () => {
    setLanguagePreference("zh-CN");
    expect(t("workspace:toast_settings")).toBe("设置");
    setLanguagePreference("en");
    expect(t("workspace:toast_settings")).toBe("Settings");
    vi.stubGlobal("navigator", { languages: ["zh-Hant-TW", "fr-FR"] });
    setLanguagePreference("system");
    expect(t("workspace:toast_settings")).toBe("Settings");
  });

  it("preserves interpolated data and uses the shipped Chinese and English plural forms", () => {
    setLanguagePreference("zh-CN");
    expect(t("common:open", { title: "<script>Settings</script>" })).toBe(
      "打开<script>Settings</script>",
    );
    expect(t("chat:backgroundTaskCount", { count: 1 })).toBe("1 个后台任务");
    expect(t("chat:backgroundTaskCount", { count: 2 })).toBe("2 个后台任务");
    setLanguagePreference("en");
    expect(t("chat:backgroundTaskCount", { count: 1 })).toBe("1 background task");
    expect(t("chat:backgroundTaskCount", { count: 2 })).toBe("2 background tasks");
  });

  it("falls back to the shipped English message when a Chinese namespace is unavailable", () => {
    const chineseCommon = i18n.getResourceBundle("zh-CN", "common");
    i18n.removeResourceBundle("zh-CN", "common");
    try {
      setLanguagePreference("zh-CN");
      expect(t("common:open", { title: "项目名称" })).toBe("Open 项目名称");
    } finally {
      i18n.addResourceBundle("zh-CN", "common", chineseCommon, true, true);
    }
  });

  it("formats dates and numbers using the resolved interface locale", () => {
    vi.stubGlobal("navigator", { languages: ["zh-SG"], language: "zh-SG" });
    setLanguagePreference("system");
    expect(getFormatLocale()).toBe("zh-CN");
    setLanguagePreference("en");
    expect(getFormatLocale()).toBe("en");
    setLanguagePreference("zh-CN");
    expect(getFormatLocale()).toBe("zh-CN");
  });

  it("preserves literal URLs, paths, names, and already translated copy passed through metadata", () => {
    setLanguagePreference("zh-CN");
    for (const value of [
      "https://api2.cursor.sh",
      "C:\\Users\\name\\repo",
      "Edit: name",
      "provider:model-name",
      "设置",
      "Settings",
      "workspace:名字",
    ]) {
      expect(t(value)).toBe(value);
    }
    expect(t("workspace:toast_settings")).toBe("设置");
  });

  it("sets initial document metadata, follows storage notifications, and follows browser changes only for System", () => {
    const events = new EventTarget();
    const documentElement = { lang: "", dir: "" };
    let raw = '{"language":"zh-CN"}';
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", { getItem: () => raw });
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    const dispose = initializeI18n();
    try {
      expect(t("workspace:toast_settings")).toBe("设置");
      expect(documentElement).toEqual({ lang: "zh-CN", dir: "ltr" });
      events.dispatchEvent(new Event("languagechange"));
      expect(t("workspace:toast_settings")).toBe("设置");
      raw = '{"language":"system"}';
      events.dispatchEvent(Object.assign(new Event("storage"), { key: APP_SETTINGS_STORAGE_KEY }));
      expect(t("workspace:toast_settings")).toBe("Settings");
      expect(documentElement.lang).toBe("en");
      vi.stubGlobal("navigator", { languages: ["zh-Hans-SG"] });
      events.dispatchEvent(new Event("languagechange"));
      expect(t("workspace:toast_settings")).toBe("设置");
      raw = '{"language":"en"}';
      events.dispatchEvent(
        Object.assign(new Event("synara:local_storage_change"), {
          detail: { key: APP_SETTINGS_STORAGE_KEY },
        }),
      );
      expect(t("workspace:toast_settings")).toBe("Settings");
      expect(documentElement).toEqual({ lang: "en", dir: "ltr" });
    } finally {
      dispose();
    }
  });
});
