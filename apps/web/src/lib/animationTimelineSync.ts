// pin stepped spinners to the document timeline origin: independently mounted instances advance at different moments (the Chromium probe measured GPU-process CPU, not hardware GPU)

import { useLayoutEffect, type RefObject } from "react";

export function syncAnimationsToTimelineOrigin(element: Element | null): void {
  if (!element || typeof element.getAnimations !== "function") {
    return;
  }
  for (const animation of element.getAnimations()) {
    try {
      animation.startTime = 0;
    } catch {
      // a detached or already-finished animation cannot be re-timed
    }
  }
}

export function useTimelineSynchronizedAnimations(ref: RefObject<Element | null>): void {
  useLayoutEffect(() => {
    syncAnimationsToTimelineOrigin(ref.current);
  }, [ref]);
}
