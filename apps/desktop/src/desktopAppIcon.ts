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
  readonly isBetaFlavor?: boolean;
}

const APP_ICON_RESOURCE_NAMES = {
  darwin: {
    default: "dock-icon.png",
    icon: "app-icon-macos.png",
    dark: "dock-icon-dark.png",
    beta: "dock-icon-beta.png",
  },
  // Windows and Linux have no dark artwork yet, so the dark preference falls back to the same default icon those platforms always used.
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
  readonly isBetaFlavor: boolean;
}

// macOS 26 renders the bundled Icon Composer asset with the Liquid Glass
// material, which reacts to appearance and pointer on its own. Any runtime dock
// image replaces that live icon with a flat bitmap. Stable Default and Beta
// Beta use their bundled artwork; Beta Default explicitly selects the white
// bitmap, distinct from its blue bundled icon.
export function usesMacBundleAppIcon(input: MacBundleAppIconInput): boolean {
  if (input.platform !== "darwin" || input.usesLegacyDockIcon) return false;
  return (
    (input.icon === "default" && !input.isBetaFlavor) ||
    (input.icon === "beta" && input.isBetaFlavor)
  );
}

export function shouldUpdateDesktopAppIcon(
  currentIcon: DesktopAppIcon,
  requestedIcon: DesktopAppIcon,
): boolean {
  return currentIcon !== requestedIcon;
}

export function desktopAppIconResourceName(input: DesktopAppIconResourceInput): string {
  if (
    input.isBetaFlavor &&
    (input.icon === "default" || (input.icon === "dark" && input.platform !== "darwin"))
  ) {
    if (input.platform === "darwin") return "dock-icon.png";
    return input.platform === "linux"
      ? "app-icon-default-linux.png"
      : "app-icon-default-windows.ico";
  }
  if (input.platform === "darwin" && input.icon === "default") {
    return input.isDarkAppearance ? "dock-icon-dark.png" : "dock-icon.png";
  }
  return APP_ICON_RESOURCE_NAMES[input.platform][input.icon];
}
