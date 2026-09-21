// the traffic lights are placed by Electron main while the chrome bar is rendered by the web app — these constants keep the two hand-synced numbers from drifting

/** kept literal (`h-[46px]`) so Tailwind can scan it; drift guarded by a test */
export const CHAT_SURFACE_HEADER_HEIGHT_PX = 46;

export const MAC_TRAFFIC_LIGHT_INSET_X_PX = 16;

/** the dot measures ~14px across — a 12px-dot assumption is what previously misaligned the lights */
export const MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX = 7;

/** dotCenterY = y + radius, headerCenterY = height/2 ⇒ y = height/2 − radius */
export function getMacTrafficLightPosition(): { x: number; y: number } {
  return {
    x: MAC_TRAFFIC_LIGHT_INSET_X_PX,
    y: Math.round(CHAT_SURFACE_HEADER_HEIGHT_PX / 2 - MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX),
  };
}

/** native traffic lights don't scale with webContents zoom — callers divide by the live zoom factor */
export const MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX = 90;

export const DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_VAR =
  "--desktop-top-bar-traffic-light-gutter";

/** coerce an untrusted zoom to a usable multiplier — a bogus value degrades to "no zoom" instead of NaN */
export function normalizeDesktopZoomFactor(zoomFactor: unknown): number {
  return typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0
    ? zoomFactor
    : 1;
}

/** inverse-scales so the on-screen gap stays aligned with the native lights */
export function resolveMacDesktopTopBarTrafficLightGutterCssPx(zoomFactor: number): number {
  return Math.round(
    MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX / normalizeDesktopZoomFactor(zoomFactor),
  );
}

export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** at zoom z, one CSS px covers z DIPs — native views are never zoomed, so raw CSS numbers miss their DOM slot by 1/z */
export function resolveDesktopDipRectFromCssRect(
  rect: DesktopRect,
  zoomFactor: number,
): DesktopRect {
  const safeZoom = normalizeDesktopZoomFactor(zoomFactor);
  if (safeZoom === 1) {
    return rect;
  }
  return {
    x: rect.x * safeZoom,
    y: rect.y * safeZoom,
    width: rect.width * safeZoom,
    height: rect.height * safeZoom,
  };
}
