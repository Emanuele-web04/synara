import { describe, expect, it } from "vitest";
import { initializeDesktopI18n, t, translateNativeMenuRoles } from "./i18n";

describe("native interface text", () => {
  it("reads English catalog messages", () => {
    expect(t("desktop:settings")).toBe("Settings...");
  });

  it("does not interpret literal app data or renderer namespaces as native translation keys", () => {
    for (const value of [
      "https://api2.cursor.sh",
      "C:\\Users\\name",
      "Edit: name",
      "provider:model-name",
      "workspace:toast_settings",
    ])
      expect(t(value)).toBe(value);
  });

  it("interpolates app and error data without looking them up as messages", () => {
    expect(t("desktop:quit", { app: "desktop:settings" })).toBe("Quit desktop:settings?");
  });

  it("follows the system language order and explicit desktop preferences", () => {
    let languages: readonly string[] = ["fr-FR", "en-US"];
    initializeDesktopI18n("system", () => languages);
    expect(t("desktop:settings")).not.toBe("Settings...");
    initializeDesktopI18n("en", () => languages);
    expect(t("desktop:settings")).toBe("Settings...");
    languages = ["not_a_locale", "es-MX"];
    initializeDesktopI18n("system", () => languages);
    expect(t("desktop:settings")).not.toBe("Settings...");
    initializeDesktopI18n("system", () => ["en-US"]);
  });

  it("translates native menu roles by role rather than English labels", () => {
    initializeDesktopI18n("fr", () => ["en-US"]);
    const group = {
      label: "Substitutions",
      submenu: {
        items: [
          { label: "Show Substitutions", role: "showSubstitutions" },
          { label: "Smart Quotes", role: "toggleSmartQuotes" },
        ],
      },
    };
    const menu = {
      items: [
        {
          label: "Edit",
          role: "editMenu",
          submenu: { items: [{ label: "Undo", role: "undo" }, group] },
        },
      ],
    };
    translateNativeMenuRoles(menu, "Synara");
    expect(menu.items[0]?.submenu?.items[0]?.label).not.toBe("Undo");
    expect(group.label).not.toBe("Substitutions");
    initializeDesktopI18n("system", () => ["en-US"]);
  });
});
