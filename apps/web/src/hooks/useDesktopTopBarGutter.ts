// FILE: useDesktopTopBarGutter.ts
// Purpose: Decide when desktop top bars must clear the macOS traffic light buttons.
// Layer: Shared web shell chrome
// Depends on: appSettings sidebar side, sidebar context, electron env detection.

import type { SidebarSide } from "~/appSettings";
import { useAppSettings } from "~/appSettings";
import { isElectron } from "~/env";
import { useSidebar } from "~/components/ui/sidebar";
import { isMacPlatform } from "~/lib/utils";

/**
 * Tailwind padding that clears the macOS traffic light cluster
 * (positioned at x=16, y=18 in the Electron BrowserWindow, see apps/desktop main).
 *
 * The 3-button cluster ends at roughly x=68 (16px inset + ~52px cluster); this
 * gutter keeps the leading controls right next to the lights (~10px breathing
 * room) instead of floating far to the right. Both the base and `sm:` variants
 * are emitted so this gutter wins over any responsive horizontal-padding class
 * (e.g. `sm:px-5`) — `twMerge` only resolves conflicts within the same breakpoint.
 *
 * Single source of truth: every top bar AND the open-sidebar header use this so
 * the leading controls sit at the same x whether the sidebar is open or closed.
 */
export const DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS = "pl-[78px] sm:pl-[78px]";

/**
 * Pure helper: should a top bar at the left edge of the desktop window reserve
 * space for the macOS traffic light buttons?
 *
 * The traffic lights live in the renderer area (titleBarStyle = "hiddenInset"),
 * so any chrome surface that sits flush against the window's left edge needs a
 * gutter, or its leading controls will collide with the close/minimize/zoom
 * buttons. The sidebar provides that gutter when it is on the left AND visible;
 * otherwise the next surface to the right has to provide it instead.
 */
export function shouldReserveDesktopTopBarTrafficLightGutter(input: {
  isElectron: boolean;
  isMacDesktop: boolean;
  sidebarSide: SidebarSide;
  sidebarOpen: boolean;
  isMobile: boolean;
}): boolean {
  if (!input.isElectron) return false;
  if (!input.isMacDesktop) return false;
  if (input.sidebarSide === "right") return true;
  // Mobile drawers float above content rather than reserving a column,
  // so the chat header always owns the left edge in that mode.
  if (input.isMobile) return true;
  return !input.sidebarOpen;
}

/**
 * React hook variant of {@link shouldReserveDesktopTopBarTrafficLightGutter}
 * that returns the gutter className (or `null` when no gutter is needed).
 *
 * Use this for any chrome surface whose top bar can sit flush against the
 * window's left edge: chat header, settings header, workspace header, etc.
 */
export function useDesktopTopBarTrafficLightGutterClassName(): string | null {
  const { settings } = useAppSettings();
  const { isMobile, open } = useSidebar();
  const isMacDesktop = typeof navigator !== "undefined" ? isMacPlatform(navigator.platform) : false;
  return shouldReserveDesktopTopBarTrafficLightGutter({
    isElectron,
    isMacDesktop,
    sidebarSide: settings.sidebarSide,
    sidebarOpen: open,
    isMobile,
  })
    ? DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS
    : null;
}
