// FILE: useDesktopTopBarGutter.ts
// Purpose: Decide when desktop top bars must clear the macOS traffic light buttons.
// Layer: Shared web shell chrome
// Depends on: sidebar context, electron env detection.

import { isElectron } from "~/env";
import { useSidebar } from "~/components/ui/sidebar";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";

/**
 * Tailwind padding that clears the macOS traffic light cluster
 * (positioned at x=16, y=16 in the Electron BrowserWindow, see apps/desktop main).
 *
 * The 3-button cluster ends at roughly x=68 (16px inset + ~52px cluster); this
 * gutter places the leading controls ~36px to the right of the lights so they
 * read as a clearly separate group instead of crowding the green button.
 *
 * IMPORTANT — why the `!` (important) modifier:
 * Host headers carry their own horizontal padding (`px-4`, `px-3 sm:px-5`, …).
 * `twMerge` does NOT treat `px-*` and `pl-*` as conflicting in this direction, so
 * BOTH survive a `cn()` call and the winner is left to CSS-cascade order — which
 * differs per header (`px-4` vs `px-3 sm:px-5`), making the leading controls land
 * at a DIFFERENT x when the sidebar is open vs closed. Marking the gutter
 * `!important` makes `padding-left` always beat the non-important base
 * `px-*`, so every surface resolves to the exact same x in both states. Both the
 * base and `sm:` variants are emitted so the override also wins at `sm:` (e.g.
 * over `sm:px-5`).
 *
 * Single source of truth: every top bar AND the open-sidebar header use this so
 * the leading controls sit at the same x whether the sidebar is open or closed.
 * This is the one knob to tune the lights→controls gap. The three macOS dots at
 * `trafficLightPosition.x = 16` span to ~70px, so 84px leaves a tight ~14px gap
 * before the toggle (was 104px / ~34px, which read as too far from the lights).
 */
export const DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS = "pl-[84px]! sm:pl-[84px]!";

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

/**
 * Tailwind padding that clears the Windows caption-button cluster.
 *
 * On Windows the Electron shell is frameless (`frame: false`, see apps/desktop
 * main) and the renderer owns the minimize/maximize/close buttons. They are
 * rendered ONCE as a viewport-fixed cluster pinned to the window's top-right
 * corner (see {@link DesktopWindowControls} mounted in the root route), mirroring
 * how macOS insets its traffic lights at the top-left.
 *
 * Each caption button is 46px wide (matching {@link CHAT_SURFACE_HEADER_HEIGHT_PX}),
 * so the three-button cluster spans 138px. Any top bar that can sit flush against
 * the window's right edge reserves that width here so its trailing controls never
 * slide underneath the floating buttons.
 *
 * The `!` (important) modifier is required for the same reason as the traffic-light
 * gutter: host headers carry their own `px-*` padding that `twMerge` does not treat
 * as conflicting with `pr-*`, so the override must win the cascade outright. Both the
 * base and `sm:` variants are emitted so it also beats `sm:px-*`.
 */
export const DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS = "pr-[138px]! sm:pr-[138px]!";

/**
 * Pure helper: should a top bar at the right edge of the desktop window reserve
 * space for the Windows caption buttons? Unlike the macOS traffic lights (whose
 * column is usually owned by the sidebar), the caption cluster always floats at
 * the window's top-right, so every right-flush chrome surface reserves the gutter.
 */
export function shouldReserveDesktopTopBarWindowControlsGutter(input: {
  isElectron: boolean;
  isWindowsDesktop: boolean;
}): boolean {
  return input.isElectron && input.isWindowsDesktop;
}

/**
 * React hook variant of {@link shouldReserveDesktopTopBarWindowControlsGutter}
 * that returns the gutter className (or `null` when no gutter is needed).
 *
 * Use this for any chrome surface whose top bar can sit flush against the window's
 * right edge: chat header, workspace header, plugin nav, the right dock header, etc.
 */
export function useDesktopTopBarWindowControlsGutterClassName(): string | null {
  const isWindowsDesktop =
    typeof navigator !== "undefined" ? isWindowsPlatform(navigator.platform) : false;
  return shouldReserveDesktopTopBarWindowControlsGutter({
    isElectron,
    isWindowsDesktop,
  })
    ? DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS
    : null;
}
