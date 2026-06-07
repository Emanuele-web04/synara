// FILE: useDesktopTopBarGutter.ts
// Purpose: Decide when desktop top bars must clear the macOS traffic light buttons.
// Layer: Shared web shell chrome
// Depends on: sidebar context, electron env detection.

import {
  DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR,
  resolveMacDesktopTopBarTrafficLightGutterCssPx,
} from "@t3tools/shared/desktopChrome";
import { useLayoutEffect } from "react";

import { isElectron } from "~/env";
import { useSidebar } from "~/components/ui/sidebar";
import { isMacPlatform } from "~/lib/utils";

/**
 * Class name backed by `index.css` (not Tailwind) so the gutter survives zoom
 * retuning via {@link DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR}.
 */
export const DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS = "desktop-top-bar-traffic-light-gutter";

/**
 * Pure helper: should a top bar at the left edge of the desktop window reserve
 * space for the macOS traffic light buttons?
 *
 * The traffic lights live in the renderer area (titleBarStyle = "hiddenInset"),
 * so any chrome surface that sits flush against the window's left edge needs a
 * gutter, or its leading controls will collide with the close/minimize/zoom
 * buttons. The sidebar always sits on the left and provides that gutter while it
 * is open; when it is collapsed — or on mobile, where the drawer floats over
 * content instead of reserving a column — the next surface to the right has to
 * provide it instead.
 */
export function shouldReserveDesktopTopBarTrafficLightGutter(input: {
  isElectron: boolean;
  isMacDesktop: boolean;
  sidebarOpen: boolean;
  isMobile: boolean;
}): boolean {
  if (!input.isElectron) return false;
  if (!input.isMacDesktop) return false;
  // Mobile drawers float above content rather than reserving a column,
  // so the chat header always owns the left edge in that mode.
  if (input.isMobile) return true;
  return !input.sidebarOpen;
}

function readDesktopZoomFactor(): number {
  const bridge = window.desktopBridge;
  if (!bridge?.getZoomFactor) return 1;
  return bridge.getZoomFactor();
}

function applyTrafficLightGutterCssVar(zoomFactor: number): void {
  document.documentElement.style.setProperty(
    DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR,
    `${resolveMacDesktopTopBarTrafficLightGutterCssPx(zoomFactor)}px`,
  );
}

/**
 * Keeps the macOS traffic-light gutter CSS variable aligned with Electron page zoom.
 * Mount once near the app root (see `__root.tsx`).
 */
export function useSyncDesktopTopBarTrafficLightGutterZoom(): void {
  const isMacDesktop = typeof navigator !== "undefined" ? isMacPlatform(navigator.platform) : false;

  useLayoutEffect(() => {
    if (!isElectron || !isMacDesktop) {
      return;
    }

    applyTrafficLightGutterCssVar(readDesktopZoomFactor());

    const bridge = window.desktopBridge;
    const unsubscribe = bridge?.onZoomFactorChange?.((zoomFactor) => {
      applyTrafficLightGutterCssVar(zoomFactor);
    });

    // Preload can attach after the first layout pass; re-apply on the next frame.
    const frame = requestAnimationFrame(() => {
      applyTrafficLightGutterCssVar(readDesktopZoomFactor());
    });

    return () => {
      cancelAnimationFrame(frame);
      unsubscribe?.();
      document.documentElement.style.removeProperty(DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR);
    };
  }, [isMacDesktop]);
}

/**
 * React hook variant of {@link shouldReserveDesktopTopBarTrafficLightGutter}
 * that returns the gutter className (or `null` when no gutter is needed).
 *
 * Use this for any chrome surface whose top bar can sit flush against the
 * window's left edge: chat header, settings header, workspace header, etc.
 */
export function useDesktopTopBarTrafficLightGutterClassName(): string | null {
  const { isMobile, open } = useSidebar();
  const isMacDesktop = typeof navigator !== "undefined" ? isMacPlatform(navigator.platform) : false;
  return shouldReserveDesktopTopBarTrafficLightGutter({
    isElectron,
    isMacDesktop,
    sidebarOpen: open,
    isMobile,
  })
    ? DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS
    : null;
}
