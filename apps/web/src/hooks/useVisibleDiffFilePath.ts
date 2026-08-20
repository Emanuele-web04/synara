import { useEffect, useState, type RefObject } from "react";

import {
  readDiffFileAnchors,
  readDiffFileOffsetTops,
  resolveDiffRenderSurface,
} from "../lib/diffScrollSurface";

const VISIBLE_DIFF_FILE_TOLERANCE_PX = 8;

export function resolveVisibleDiffFilePath(surface: HTMLElement): string | null {
  const anchors = readDiffFileAnchors(surface);
  if (anchors.length === 0) {
    return null;
  }
  const offsetTops = readDiffFileOffsetTops(surface, anchors);
  const threshold = surface.scrollTop + VISIBLE_DIFF_FILE_TOLERANCE_PX;
  let visiblePath = anchors[0]?.path ?? null;
  for (const anchor of anchors) {
    if ((offsetTops.get(anchor.path) ?? 0) > threshold) {
      break;
    }
    visiblePath = anchor.path;
  }
  return visiblePath;
}

export function useVisibleDiffFilePath(
  viewportRef: RefObject<HTMLElement | null>,
  contentKey: unknown,
): string | null {
  const [visibleFilePath, setVisibleFilePath] = useState<string | null>(null);

  useEffect(() => {
    const surface = resolveDiffRenderSurface(viewportRef.current);
    if (!surface) {
      setVisibleFilePath(null);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      if (surface.clientHeight === 0) {
        return;
      }
      const nextPath = resolveVisibleDiffFilePath(surface);
      setVisibleFilePath((previous) => (previous === nextPath ? previous : nextPath));
    };
    const schedule = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    surface.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(surface);
    for (const anchor of readDiffFileAnchors(surface)) {
      resizeObserver.observe(anchor.element);
    }

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      surface.removeEventListener("scroll", schedule);
      resizeObserver.disconnect();
    };
  }, [contentKey, viewportRef]);

  return visibleFilePath;
}
