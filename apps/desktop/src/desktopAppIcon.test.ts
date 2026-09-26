import { describe, expect, it } from "vitest";

import {
  desktopAppIconResourceName,
  isDesktopAppIcon,
  shouldUpdateDesktopAppIcon,
  usesMacBundleAppIcon,
} from "./desktopAppIcon";

describe("desktop app icons", () => {
  it("accepts only supported preferences", () => {
    expect(isDesktopAppIcon("default")).toBe(true);
    expect(isDesktopAppIcon("icon")).toBe(true);
    expect(isDesktopAppIcon("dark")).toBe(true);
    expect(isDesktopAppIcon("beta")).toBe(true);
    expect(isDesktopAppIcon("unknown")).toBe(false);
  });

  it("selects the alternate native asset on every desktop platform", () => {
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "darwin", isDarkAppearance: false }),
    ).toBe("app-icon-macos.png");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "win32", isDarkAppearance: false }),
    ).toBe("app-icon-windows.ico");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "linux", isDarkAppearance: false }),
    ).toBe("app-icon-linux.png");
  });

  it("uses a PNG for the macOS default icon in light and dark mode", () => {
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "darwin", isDarkAppearance: false }),
    ).toBe("dock-icon.png");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "darwin", isDarkAppearance: true }),
    ).toBe("dock-icon-dark.png");
  });

  it("always uses the dark artwork when the dark preference is selected", () => {
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "darwin", isDarkAppearance: false }),
    ).toBe("dock-icon-dark.png");
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "darwin", isDarkAppearance: true }),
    ).toBe("dock-icon-dark.png");
  });

  it("selects beta artwork on every desktop platform", () => {
    expect(
      desktopAppIconResourceName({ icon: "beta", platform: "darwin", isDarkAppearance: false }),
    ).toBe("dock-icon-beta.png");
    expect(
      desktopAppIconResourceName({ icon: "beta", platform: "darwin", isDarkAppearance: true }),
    ).toBe("dock-icon-beta.png");
    expect(
      desktopAppIconResourceName({ icon: "beta", platform: "linux", isDarkAppearance: false }),
    ).toBe("app-icon-beta-linux.png");
    expect(
      desktopAppIconResourceName({ icon: "beta", platform: "win32", isDarkAppearance: false }),
    ).toBe("app-icon-beta-windows.ico");
  });

  it("falls back to the default icon for the dark preference off macOS", () => {
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "linux", isDarkAppearance: false }),
    ).toBe("icon.png");
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "win32", isDarkAppearance: false }),
    ).toBe("icon.ico");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "linux", isDarkAppearance: true }),
    ).toBe("icon.png");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "win32", isDarkAppearance: true }),
    ).toBe("icon.ico");
  });

  it("leaves the Liquid Glass bundle icon alone for the macOS default preference", () => {
    expect(
      usesMacBundleAppIcon({
        icon: "default",
        platform: "darwin",
        usesLegacyDockIcon: false,
        isBetaFlavor: false,
      }),
    ).toBe(true);
    expect(
      usesMacBundleAppIcon({
        icon: "default",
        platform: "darwin",
        usesLegacyDockIcon: true,
        isBetaFlavor: false,
      }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({
        icon: "icon",
        platform: "darwin",
        usesLegacyDockIcon: false,
        isBetaFlavor: false,
      }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({
        icon: "dark",
        platform: "darwin",
        usesLegacyDockIcon: false,
        isBetaFlavor: false,
      }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({
        icon: "default",
        platform: "linux",
        usesLegacyDockIcon: false,
        isBetaFlavor: false,
      }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({
        icon: "default",
        platform: "win32",
        usesLegacyDockIcon: false,
        isBetaFlavor: false,
      }),
    ).toBe(false);
  });

  it("leaves the beta bundle icon alone only on the beta flavor", () => {
    expect(
      usesMacBundleAppIcon({
        icon: "beta",
        platform: "darwin",
        usesLegacyDockIcon: false,
        isBetaFlavor: true,
      }),
    ).toBe(true);
    expect(
      usesMacBundleAppIcon({
        icon: "beta",
        platform: "darwin",
        usesLegacyDockIcon: false,
        isBetaFlavor: false,
      }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({
        icon: "beta",
        platform: "darwin",
        usesLegacyDockIcon: true,
        isBetaFlavor: true,
      }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({
        icon: "beta",
        platform: "linux",
        usesLegacyDockIcon: false,
        isBetaFlavor: true,
      }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({
        icon: "beta",
        platform: "win32",
        usesLegacyDockIcon: false,
        isBetaFlavor: true,
      }),
    ).toBe(false);
  });

  it("does not reapply the icon when renderer hydration matches native state", () => {
    expect(shouldUpdateDesktopAppIcon("default", "default")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("icon", "icon")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("dark", "dark")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("default", "dark")).toBe(true);
    expect(shouldUpdateDesktopAppIcon("dark", "icon")).toBe(true);
  });
});
