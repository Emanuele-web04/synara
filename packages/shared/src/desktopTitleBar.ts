// FILE: desktopTitleBar.ts
// Purpose: Resolve which Electron title-bar mode Windows/Linux should use.
// Layer: Shared runtime utilities (type-only contract dep; safe in main + renderer)

import type { DesktopCustomTitleBarMode } from "@synara/contracts";

/**
 * Custom (frameless) title bars are supported on Windows and Linux. macOS keeps
 * native traffic lights via `titleBarStyle: "hiddenInset"` and is not toggled.
 */
export function supportsCustomTitleBar(platform: string): boolean {
  return platform === "win32" || platform === "linux";
}

/**
 * Default preference when nothing is persisted yet.
 * Windows already shipped frameless; Linux defaults on so the chrome matches
 * the app without an extra opt-in step (users can switch back for tiling WMs).
 */
export function defaultCustomTitleBarPreference(platform: string): boolean {
  return supportsCustomTitleBar(platform);
}

/**
 * Whether the BrowserWindow should be created with `frame: false`.
 * `preference` is `null` when the user has never set an explicit value.
 */
export function resolveCustomTitleBarActive(input: {
  readonly platform: string;
  readonly preference: boolean | null;
}): boolean {
  if (!supportsCustomTitleBar(input.platform)) {
    return false;
  }
  if (input.preference === null) {
    return defaultCustomTitleBarPreference(input.platform);
  }
  return input.preference;
}

/**
 * Resolve the live caption-control owner for a supported custom title bar.
 * Windows keeps native controls through Window Controls Overlay; Linux retains
 * the existing renderer controls because desktop-environment support varies.
 */
export function resolveDesktopCustomTitleBarMode(input: {
  readonly platform: string;
  readonly preference: boolean | null;
}): DesktopCustomTitleBarMode {
  if (!resolveCustomTitleBarActive(input)) {
    return "native-frame";
  }
  return input.platform === "win32" ? "native-overlay" : "renderer";
}
