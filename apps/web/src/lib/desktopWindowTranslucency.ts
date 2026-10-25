// FILE: desktopWindowTranslucency.ts
// Purpose: Reads how the desktop window backs the translucent shell, as announced by preload.
// Layer: Web desktop-capability helper
// Exports: readDesktopWindowTranslucency

import type { DesktopWindowTranslucency } from "@synara/contracts";
import { readWorkspaceFrame } from "./hosts/workspaceFrame";
import { isMacNavigatorPlatform } from "./utils";

/**
 * `native` on macOS (vibrancy plus adjustable blur), `compositor` on Hyprland (the compositor
 * blurs a transparent window), null for an opaque window or a plain browser. The desktop
 * fixes this when it creates the window, so it never changes during a session.
 */
export function readDesktopWindowTranslucency(): DesktopWindowTranslucency | null {
  if (typeof window === "undefined") return null;
  const frame = readWorkspaceFrame();
  // A Remote pane inherits only the controlling window's display metadata, not its native API.
  if (frame) {
    if (frame.controller.desktop !== true) return null;
    const readBacking = frame.controller.presentation?.readWindowTranslucency;
    // Older desktop controllers predate this capability. Preserve their Mac vibrancy
    // presentation only when the getter is absent; an explicit null stays authoritative.
    const value =
      readBacking === undefined ? (isMacNavigatorPlatform() ? "native" : null) : readBacking();
    return value === "native" || value === "compositor" ? value : null;
  }
  const value = window.desktopBridge?.windowTranslucency;
  return value === "native" || value === "compositor" ? value : null;
}
