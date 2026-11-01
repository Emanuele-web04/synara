// FILE: desktopWindowTranslucency.ts
// Purpose: Reads how the desktop window backs the translucent shell, as announced by preload.
// Layer: Web desktop-capability helper
// Exports: readDesktopWindowTranslucency

import type { DesktopWindowTranslucency } from "@synara/contracts";

/**
 * `native` on macOS (vibrancy plus adjustable blur), `compositor` on Hyprland (the compositor
 * blurs a transparent window), null for an opaque window or a plain browser. The desktop
 * fixes this when it creates the window, so it never changes during a session.
 */
export function readDesktopWindowTranslucency(): DesktopWindowTranslucency | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.windowTranslucency ?? null;
}
