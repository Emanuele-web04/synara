// FILE: desktopAppIcon.ts
// Purpose: Validate and persist the app-icon preference and map it to platform resources.
// Layer: Desktop-native preference logic

import * as FS from "node:fs";
import * as Path from "node:path";

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
  },
  // Windows and Linux have no dark artwork yet, so the dark preference falls
  // back to the same default icon those platforms always used.
  linux: {
    default: "icon.png",
    icon: "app-icon-linux.png",
    dark: "icon.png",
  },
  win32: {
    default: "icon.ico",
    icon: "app-icon-windows.ico",
    dark: "icon.ico",
  },
} as const;

export const isDesktopAppIcon = Schema.is(DesktopAppIcon);

export function writeDesktopAppIconPreference(filePath: string, icon: DesktopAppIcon): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, icon, "utf8");
}

// Missing or blank files use the caller's fallback without writing. Unknown
// values reset on disk; known but inactive choices stay saved for another flavor.
export function readDesktopAppIconPreference(
  filePath: string,
  options: {
    readonly fallbackIcon?: DesktopAppIcon;
    readonly inactiveIcons?: readonly string[];
    readonly onResetError?: (error: unknown) => void;
  } = {},
): DesktopAppIcon {
  const fallbackIcon = options.fallbackIcon ?? "default";
  let stored: string;
  try {
    stored = FS.readFileSync(filePath, "utf8").trim();
  } catch {
    return fallbackIcon;
  }
  if (stored.length === 0 || options.inactiveIcons?.includes(stored)) return fallbackIcon;
  if (isDesktopAppIcon(stored)) return stored;
  try {
    writeDesktopAppIconPreference(filePath, fallbackIcon);
  } catch (error) {
    options.onResetError?.(error);
  }
  return fallbackIcon;
}

interface MacBundleAppIconInput {
  readonly icon: DesktopAppIcon;
  readonly platform: DesktopPlatform;
  readonly usesLegacyDockIcon: boolean;
}

// macOS 26 renders the bundled Icon Composer asset with the Liquid Glass
// material, which reacts to appearance and pointer on its own. Any runtime dock
// image replaces that live icon with a flat bitmap, so the default preference
// must leave the bundle icon alone instead of picking artwork here.
export function usesMacBundleAppIcon(input: MacBundleAppIconInput): boolean {
  return input.platform === "darwin" && input.icon === "default" && !input.usesLegacyDockIcon;
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
