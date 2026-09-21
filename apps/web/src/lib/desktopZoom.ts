// zoom converts renderer CSS px to the DIPs native surfaces (traffic lights, browser view) are positioned in; the bridge can be absent (web build) or predate the zoom channel, so the defensive read lives here

import { normalizeDesktopZoomFactor } from "@synara/shared/desktopChrome";

export function readDesktopZoomFactor(): number {
  const bridge = window.desktopBridge;
  if (!bridge?.getZoomFactor) return 1;
  return normalizeDesktopZoomFactor(bridge.getZoomFactor());
}

/**
 * Subscribe to shell zoom changes. Returns an unsubscribe function; when the bridge
 * cannot report zoom the listener simply never fires.
 */
export function subscribeDesktopZoomFactor(listener: (zoomFactor: number) => void): () => void {
  const bridge = window.desktopBridge;
  const unsubscribe = bridge?.onZoomFactorChange?.((zoomFactor) => {
    listener(normalizeDesktopZoomFactor(zoomFactor));
  });
  return () => {
    unsubscribe?.();
  };
}
