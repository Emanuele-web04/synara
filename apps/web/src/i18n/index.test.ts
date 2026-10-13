import { afterEach, describe, expect, it, vi } from "vitest";

import { getFormatLocale, initializeI18n, i18n, setLanguagePreference, t } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  setLanguagePreference("system");
});

describe("bundled translations", () => {
  it("mirrors stored and changed preferences to a compatible native bridge", async () => {
    const events = new EventTarget();
    const setNativePreference = vi.fn(async () => {});
    Object.assign(events, { desktopBridge: { setLanguagePreference: setNativePreference } });
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", { getItem: () => '{"language":"es"}' });
    const dispose = initializeI18n();
    try {
      expect(setNativePreference).toHaveBeenLastCalledWith("es");
      setLanguagePreference("en");
      expect(setNativePreference).toHaveBeenLastCalledWith("en");
      const count = setNativePreference.mock.calls.length;
      setLanguagePreference("en");
      expect(setNativePreference).toHaveBeenCalledTimes(count);
    } finally {
      dispose();
    }
  });

  it("notifies System subscribers when only the browser region changes", () => {
    const events = new EventTarget();
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    const dispose = initializeI18n();
    const changed = vi.fn();
    i18n.on("languageChanged", changed);
    try {
      vi.stubGlobal("navigator", { languages: ["en-US"] });
      events.dispatchEvent(new Event("languagechange"));
      expect(changed).toHaveBeenCalledWith("en");
    } finally {
      i18n.off("languageChanged", changed);
      dispose();
    }
  });

  it("switches synchronously and falls back to the English source including punctuation", () => {
    setLanguagePreference("es");
    expect(t("Settings")).toBe("Ajustes");
    expect(t("Unknown: sentence.with punctuation")).toBe("Unknown: sentence.with punctuation");
    setLanguagePreference("en");
    expect(t("Settings")).toBe("Settings");
  });

  it("interpolates values as data and uses locale-aware plurals", () => {
    i18n.addResourceBundle("es", "translation", {
      "Hello {{name}}": "Hola {{name}}",
      "{{count}} file_one": "{{count}} archivo",
      "{{count}} file_other": "{{count}} archivos",
    });
    setLanguagePreference("es");
    expect(t("Hello {{name}}", { name: "<script>Settings</script>" })).toBe(
      "Hola <script>Settings</script>",
    );
    expect(t("{{count}} file", { count: 1 })).toBe("1 archivo");
    expect(t("{{count}} file", { count: 2 })).toBe("2 archivos");
    expect(t("Unknown {{name}}", { name: "Settings" })).toBe("Unknown Settings");
  });

  it("preserves browser regional formatting for System and uses explicit interface locales otherwise", () => {
    vi.stubGlobal("navigator", { languages: ["es-MX"], language: "es-MX" });
    setLanguagePreference("system");
    expect(i18n.language).toBe("es");
    expect(getFormatLocale()).toBeUndefined();
    setLanguagePreference("en");
    expect(getFormatLocale()).toBe("en");
    setLanguagePreference("es");
    expect(getFormatLocale()).toBe("es");
  });

  it("sets the initial document language and follows browser language changes only for System", () => {
    const events = new EventTarget();
    const documentElement = { lang: "" };
    let raw = '{"language":"es"}';
    const storage = { getItem: () => raw };
    vi.stubGlobal("window", events);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    const dispose = initializeI18n();
    try {
      expect(t("Settings")).toBe("Ajustes");
      expect(documentElement.lang).toBe("es");
      events.dispatchEvent(new Event("languagechange"));
      expect(t("Settings")).toBe("Ajustes");
      raw = '{"language":"system"}';
      events.dispatchEvent(
        Object.assign(new Event("storage"), { key: "synara:app-settings:v1", storageArea: null }),
      );
      expect(t("Settings")).toBe("Settings");
      expect(documentElement.lang).toBe("en");
      vi.stubGlobal("navigator", { languages: ["es-MX"] });
      events.dispatchEvent(new Event("languagechange"));
      expect(t("Settings")).toBe("Ajustes");
      raw = '{"language":"en"}';
      events.dispatchEvent(
        Object.assign(new Event("synara:local_storage_change"), {
          detail: { key: "synara:app-settings:v1" },
        }),
      );
      expect(t("Settings")).toBe("Settings");
    } finally {
      dispose();
    }
  });
});
