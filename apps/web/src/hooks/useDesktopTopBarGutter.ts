import {
  DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR,
  resolveMacDesktopTopBarTrafficLightGutterCssPx,
} from "@synara/shared/desktopChrome";
import { useLayoutEffect } from "react";

import { isElectron } from "~/env";
import { useSidebar } from "~/components/ui/sidebar";
import { useDesktopCustomTitleBarActive } from "~/hooks/useDesktopCustomTitleBar";
import { readDesktopZoomFactor, subscribeDesktopZoomFactor } from "~/lib/desktopZoom";
import { isMacNavigatorPlatform } from "~/lib/utils";

/**
 * Class name backed by `index.css` (not Tailwind) so the gutter survives zoom
 * retuning via {@link DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR}.
 */
export const DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS = "desktop-top-bar-traffic-light-gutter";

// traffic lights live in the renderer area (hiddenInset) — any left-flush chrome needs the gutter; the sidebar provides it while open, collapsed/mobile the next surface to the right owns it
export function shouldReserveDesktopTopBarTrafficLightGutter(input: {
  isElectron: boolean;
  isMacDesktop: boolean;
  sidebarOpen: boolean;
  isMobile: boolean;
}): boolean {
  if (!input.isElectron) return false;
  if (!input.isMacDesktop) return false;
  // Mobile drawers float above content rather than reserving a column, so the chat header always owns the left edge in that mode.
  if (input.isMobile) return true;
  return !input.sidebarOpen;
}

function applyTrafficLightGutterCssVar(zoomFactor: number): void {
  document.documentElement.style.setProperty(
    DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR,
    `${resolveMacDesktopTopBarTrafficLightGutterCssPx(zoomFactor)}px`,
  );
}

export function useSyncDesktopTopBarTrafficLightGutterZoom(): void {
  const isMacDesktop = isMacNavigatorPlatform();

  useLayoutEffect(() => {
    if (!isElectron || !isMacDesktop) {
      return;
    }

    applyTrafficLightGutterCssVar(readDesktopZoomFactor());

    const unsubscribe = subscribeDesktopZoomFactor(applyTrafficLightGutterCssVar);

    // Preload can attach after the first layout pass; re-apply on the next frame.
    const frame = requestAnimationFrame(() => {
      applyTrafficLightGutterCssVar(readDesktopZoomFactor());
    });

    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      document.documentElement.style.removeProperty(DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR);
    };
  }, [isMacDesktop]);
}

export function useDesktopTopBarTrafficLightGutterClassName(): string | null {
  const { isMobile, open } = useSidebar();
  const isMacDesktop = isMacNavigatorPlatform();
  return shouldReserveDesktopTopBarTrafficLightGutter({
    isElectron,
    isMacDesktop,
    sidebarOpen: open,
    isMobile,
  })
    ? DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS
    : null;
}

// the caption cluster renders once, viewport-fixed top-right (3×46px = 138px) — the `!` is required because twMerge doesn't treat host `px-*` as conflicting with `pr-*`; both base and `sm:` emitted
export const DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS = "pr-[138px]! sm:pr-[138px]!";

/**
 * Pure helper: should a top bar at the right edge of the desktop window reserve
 * space for the custom caption buttons? Unlike the macOS traffic lights (whose
 * column is usually owned by the sidebar), the caption cluster always floats at
 * the window's top-right, so every right-flush chrome surface reserves the gutter
 * whenever the live window is frameless.
 */
export function shouldReserveDesktopTopBarWindowControlsGutter(input: {
  isElectron: boolean;
  customTitleBarActive: boolean;
}): boolean {
  return input.isElectron && input.customTitleBarActive;
}

export function useDesktopTopBarWindowControlsGutterClassName(): string | null {
  const customTitleBarActive = useDesktopCustomTitleBarActive();
  return shouldReserveDesktopTopBarWindowControlsGutter({
    isElectron,
    customTitleBarActive,
  })
    ? DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS
    : null;
}
