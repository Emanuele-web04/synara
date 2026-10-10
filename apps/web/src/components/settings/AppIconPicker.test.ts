import { describe, expect, it } from "vitest";

import { defaultDesktopAppIconForFlavor } from "../../appSettings";
import { desktopAppIconsForPlatform } from "./AppIconPicker";

describe("desktop app icon availability", () => {
  it("offers the dark icon on macOS", () => {
    expect(desktopAppIconsForPlatform("MacIntel")).toEqual(["default", "icon", "dark"]);
    expect(desktopAppIconsForPlatform("MacIntel", "production")).toEqual([
      "default",
      "icon",
      "dark",
    ]);
    expect(desktopAppIconsForPlatform("MacIntel", "unknown")).toEqual(["default", "icon", "dark"]);
  });

  it("hides the unsupported dark icon off macOS", () => {
    expect(desktopAppIconsForPlatform("Win32")).toEqual(["default", "icon"]);
    expect(desktopAppIconsForPlatform("Linux x86_64")).toEqual(["default", "icon"]);
  });

  it("adds the beta icon only for the beta flavor", () => {
    expect(desktopAppIconsForPlatform("MacIntel", "beta")).toEqual([
      "default",
      "icon",
      "dark",
      "beta",
    ]);
    expect(desktopAppIconsForPlatform("Win32", "beta")).toEqual(["default", "icon", "beta"]);
    expect(desktopAppIconsForPlatform("Linux x86_64", "beta")).toEqual(["default", "icon", "beta"]);
  });
});

describe("desktop app icon flavor default", () => {
  it("defaults the beta flavor to the beta icon and everything else to default", () => {
    expect(defaultDesktopAppIconForFlavor("beta")).toBe("beta");
    expect(defaultDesktopAppIconForFlavor("production")).toBe("default");
    expect(defaultDesktopAppIconForFlavor("unknown")).toBe("default");
  });
});
