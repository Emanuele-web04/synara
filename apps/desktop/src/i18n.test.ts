import { describe, expect, it } from "vitest";
import { t } from "./i18n";

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
});
