// FILE: windowMaterial.ts
// Purpose: Applies the renderer's window material on macOS: native vibrancy for the opaque
//          shell, or an adjustable desktop blur (native/window-material addon) when translucent.
// Layer: Desktop main process
// Exports: MAC_WINDOW_VIBRANCY, parseDesktopWindowMaterial, createWindowMaterialApplier

import {
  DESKTOP_WINDOW_BLUR_RADIUS_MAX,
  DESKTOP_WINDOW_BLUR_RADIUS_MIN,
  type DesktopWindowMaterial,
} from "@synara/contracts";
import type { BrowserWindow } from "electron";

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
