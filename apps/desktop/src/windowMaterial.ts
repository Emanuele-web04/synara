// FILE: windowMaterial.ts
// Purpose: Decides how the desktop window backs the translucent shell (macOS vibrancy, a
//          compositor-blurred transparent window on Hyprland, or none), and applies the
//          renderer's material on macOS: native vibrancy for the opaque shell, or an
//          adjustable desktop blur (native/window-material addon) when translucent.
// Layer: Desktop main process
// Exports: MAC_WINDOW_VIBRANCY, resolveDesktopWindowTranslucency, parseDesktopWindowMaterial,
//          createWindowMaterialApplier

import {
  DESKTOP_WINDOW_BLUR_RADIUS_MAX,
  DESKTOP_WINDOW_BLUR_RADIUS_MIN,
  type DesktopWindowMaterial,
  type DesktopWindowTranslucency,
} from "@synara/contracts";
import type { BrowserWindow } from "electron";

/**
 * Linux has no vibrancy, and a see-through window only reads as glass when the compositor
 * blurs what is behind it. Hyprland blurs every transparent surface (native Wayland and
 * XWayland) with the user's `decoration:blur` settings, so only that session gets one, and
 * only once that blur is confirmed on. Elsewhere — and whenever the option cannot be read —
 * the window stays opaque rather than showing the sharp desktop behind the app.
 */
export function resolveDesktopWindowTranslucency(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Hyprland's `decoration:blur:enabled`, or null when it could not be read. */
  readonly readHyprlandBlurEnabled: () => boolean | null;
}): DesktopWindowTranslucency | null {
  if (input.platform === "darwin") return "native";
  if (input.platform !== "linux") return null;
  const hyprland =
    Boolean(input.env.HYPRLAND_INSTANCE_SIGNATURE?.trim()) ||
    (input.env.XDG_CURRENT_DESKTOP ?? "")
      .split(":")
      .some((desktop) => desktop.trim().toLowerCase() === "hyprland");
  if (!hyprland) return null;
  // A window may only go see-through on proof that the compositor blurs it: guessing from
  // Hyprland's default would show the sharp desktop behind the app when the read failed.
  return input.readHyprlandBlurEnabled() === true ? "compositor" : null;
}

/** Parses `hyprctl -j getoption decoration:blur:enabled` output. */
export function parseHyprlandBlurEnabled(stdout: string): boolean | null {
  try {
    const option: unknown = JSON.parse(stdout);
    if (!option || typeof option !== "object") return null;
    const { bool, int } = option as Record<string, unknown>;
    if (typeof bool === "boolean") return bool;
    if (typeof int === "number") return int !== 0;
    return null;
  } catch {
    return null;
  }
}

export const MAC_WINDOW_VIBRANCY = "under-window";

export interface WindowMaterialAddon {
  setBackgroundBlurRadius: (nativeWindowHandle: Buffer, radius: number) => boolean;
}

type MaterialWindow = Pick<BrowserWindow, "getNativeWindowHandle" | "setVibrancy">;

export function parseDesktopWindowMaterial(raw: unknown): DesktopWindowMaterial | null {
  if (!raw || typeof raw !== "object") return null;
  const { material, blurRadius } = raw as Record<string, unknown>;
  if (material !== "opaque" && material !== "translucent") return null;
  if (typeof blurRadius !== "number" || !Number.isFinite(blurRadius)) return null;
  const min = material === "translucent" ? DESKTOP_WINDOW_BLUR_RADIUS_MIN : 0;
  return {
    material,
    blurRadius: Math.round(Math.min(DESKTOP_WINDOW_BLUR_RADIUS_MAX, Math.max(min, blurRadius))),
  };
}

/**
 * Returns an applier that reports whether the adjustable blur took effect. The addon is
 * loaded on first translucent use; when it is missing or the private call is refused, the
 * window keeps plain vibrancy, which still reads as frosted glass.
 */
export function createWindowMaterialApplier(loadAddon: () => WindowMaterialAddon | null) {
  let addon: WindowMaterialAddon | null | undefined;
  return (window: MaterialWindow, input: DesktopWindowMaterial): boolean => {
    if (input.material === "opaque") {
      window.setVibrancy(MAC_WINDOW_VIBRANCY);
      addon?.setBackgroundBlurRadius(window.getNativeWindowHandle(), 0);
      return true;
    }
    if (addon === undefined) addon = loadAddon();
    if (addon) {
      window.setVibrancy(null);
      if (addon.setBackgroundBlurRadius(window.getNativeWindowHandle(), input.blurRadius)) {
        return true;
      }
    }
    window.setVibrancy(MAC_WINDOW_VIBRANCY);
    return false;
  };
}
