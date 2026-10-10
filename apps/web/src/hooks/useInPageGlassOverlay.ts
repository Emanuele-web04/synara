// FILE: useInPageGlassOverlay.ts
// Purpose: Registers a floating in-page surface's wrapper with the glass overlay cutout, so
//          the content beside it is cut out from under it on a whole-window glass shell.
// Layer: Desktop window material hook
// Exports: useInPageGlassOverlay

import { useEffect, useRef } from "react";

import { registerInPageGlassOverlay } from "~/lib/glassOverlayCutout";

/**
 * Ref for the wrapper of a raised surface that floats over its sibling content. While
 * `active`, that content is cut out from under the surface (see glassOverlayCutout.ts).
 */
export function useInPageGlassOverlay<T extends HTMLElement>(active: boolean) {
  const wrapperRef = useRef<T>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!active || !wrapper) return;
    return registerInPageGlassOverlay(wrapper);
  }, [active]);
  return wrapperRef;
}
