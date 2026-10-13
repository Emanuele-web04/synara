import { afterEach, describe, expect, it } from "vitest";
import {
  initializeDesktopI18n,
  setDesktopLanguagePreference,
  t,
  translateNativeMenuRoles,
} from "./i18n";

afterEach(() => initializeDesktopI18n("system", () => "en-US"));

describe("native interface language", () => {
  it("handles Electron's lowercase roles when relabeling generated menus", () => {
    const item = {
      label: "Developer Tools",
      role: "toggledevtools",
      accelerator: "Alt+Command+I",
      id: "developer-tools",
    };
    const menu = { items: [{ label: "Edit", role: "editmenu", submenu: { items: [item] } }] };
    initializeDesktopI18n("es", () => "en-US");
    translateNativeMenuRoles(menu, "Synara");
    expect(menu.items[0]?.label).toBe("Editar");
    expect(item).toEqual({
      label: "Herramientas de desarrollo",
      role: "toggledevtools",
      accelerator: "Alt+Command+I",
      id: "developer-tools",
    });
  });

  it("uses the startup preference and resolves System from the operating-system locale", () => {
    initializeDesktopI18n("es", () => "en-US");
    expect(t("Yes")).toBe("Sí");
    setDesktopLanguagePreference("system");
    expect(t("Yes")).toBe("Yes");
    initializeDesktopI18n("system", () => "es-MX");
    expect(t("Yes")).toBe("Sí");
    initializeDesktopI18n("system", () => "fr-FR");
    expect(t("Unknown: sentence.with punctuation")).toBe("Unknown: sentence.with punctuation");
    expect(t("Yes")).toBe("Yes");
  });

  it("updates native role labels while keeping role actions, IDs and accelerators intact", () => {
    const quit = {
      label: "Quit Synara Beta",
      role: "quit",
      id: "quit-action",
      accelerator: "Command+Q",
    };
    const menu = { items: [{ label: "Synara Beta", submenu: { items: [quit] } }] };
    initializeDesktopI18n("en", () => "en-US");
    translateNativeMenuRoles(menu, "Synara Beta");
    expect(quit.label).toBe("Quit Synara Beta");
    setDesktopLanguagePreference("es");
    translateNativeMenuRoles(menu, "Synara Beta");
    expect(quit).toEqual({
      label: "Salir de Synara Beta",
      role: "quit",
      id: "quit-action",
      accelerator: "Command+Q",
    });
    expect(menu.items[0]?.label).toBe("Synara Beta");
  });

  it("interpolates app and error data without looking them up as messages", () => {
    initializeDesktopI18n("es", () => "en-US");
    expect(t("Quit {{app}}?", { app: "Yes" })).toBe("¿Salir de Yes?");
  });
});
