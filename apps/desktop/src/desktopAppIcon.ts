// FILE: desktopAppIcon.ts
// Purpose: Validate app-icon preferences and map them to platform resources.
// Layer: Desktop-native preference logic

import { DesktopAppIcon } from "@synara/contracts";
import { Schema } from "effect";

type DesktopPlatform = "darwin" | "linux" | "win32";

interface DesktopAppIconResourceInput {
  readonly icon: DesktopAppIcon;
  readonly platform: DesktopPlatform;
  readonly isDarkAppearance: boolean;
}

const APP_ICON_RESOURCE_NAMES = {
  darwin: {
    default: "dock-icon.png",
    icon: "app-icon-macos.png",
    dark: "dock-icon-dark.png",
    beta: "dock-icon-beta.png",
  },
  // Windows and Linux have no dark artwork yet, so the dark preference falls
  // back to the same default icon those platforms always used.
  linux: {
    default: "icon.png",
    icon: "app-icon-linux.png",
    dark: "icon.png",
    beta: "app-icon-beta-linux.png",
  },
  win32: {
    default: "icon.ico",
    icon: "app-icon-windows.ico",
    dark: "icon.ico",
    beta: "app-icon-beta-windows.ico",
  },
} as const;

export const isDesktopAppIcon = Schema.is(DesktopAppIcon);

interface MacBundleAppIconInput {
  readonly icon: DesktopAppIcon;
  readonly platform: DesktopPlatform;
  readonly usesLegacyDockIcon: boolean;
  readonly isBetaFlavor: boolean;
}

// macOS 26 renders the bundled Icon Composer asset with the Liquid Glass
// material, which reacts to appearance and pointer on its own. Any runtime dock
// image replaces that live icon with a flat bitmap, so the default preference
// (and the beta preference on the beta flavor, whose bundle already ships beta
// artwork) must leave the bundle icon alone instead of picking artwork here.
export function usesMacBundleAppIcon(input: MacBundleAppIconInput): boolean {
  if (input.platform !== "darwin" || input.usesLegacyDockIcon) return false;
  return input.icon === "default" || (input.icon === "beta" && input.isBetaFlavor);
}

export function shouldUpdateDesktopAppIcon(
  currentIcon: DesktopAppIcon,
  requestedIcon: DesktopAppIcon,
): boolean {
  return currentIcon !== requestedIcon;
}

export function desktopAppIconResourceName(input: DesktopAppIconResourceInput): string {
  if (input.platform === "darwin" && input.icon === "default") {
    return input.isDarkAppearance ? "dock-icon-dark.png" : "dock-icon.png";
  }
  return APP_ICON_RESOURCE_NAMES[input.platform][input.icon];
}
