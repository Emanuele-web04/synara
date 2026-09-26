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

export function normalizeStoredDesktopAppIcon(stored: string): {
  readonly icon: DesktopAppIcon;
  readonly needsReset: boolean;
} {
  const trimmed = stored.trim();
  if (trimmed.length === 0) return { icon: "default", needsReset: false };
  if (isDesktopAppIcon(trimmed)) return { icon: trimmed, needsReset: false };
  // Forward-compat true reset: a newer build may have written a value this
  // build doesn't recognize. Callers write back "default" so the stale value
  // can't linger and confuse a later upgrade.
  return { icon: "default", needsReset: true };
}

export function writeDesktopAppIconPreference(filePath: string, icon: DesktopAppIcon): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, icon, "utf8");
}

// Best-effort persisted read: unrecognized values reset to "default" on disk,
// while missing or blank files read as "default" without writing. Never throws.
export function readDesktopAppIconPreference(
  filePath: string,
  onResetError?: (error: unknown) => void,
): DesktopAppIcon {
  let stored: string;
  try {
    stored = FS.readFileSync(filePath, "utf8");
  } catch {
    return "default";
  }
  const normalized = normalizeStoredDesktopAppIcon(stored);
  if (!normalized.needsReset) return normalized.icon;
  try {
    writeDesktopAppIconPreference(filePath, "default");
  } catch (error) {
    onResetError?.(error);
  }
  return "default";
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
