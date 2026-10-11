// FILE: useContainerSize.ts
// Purpose: Observe an element's content-box size with a "first measurement
//          immediate, subsequent measurements debounced" policy. The PDF viewer
//          uses this to resolve fit-width/fit-page scale without re-painting
//          every page canvas on each frame while a pane divider is dragged.
// Layer: Web PDF rendering hook
// Exports: useContainerSize

import { useEffect, useState } from "react";

import type { PdfViewportSize } from "./pdfZoom";

const DEFAULT_DEBOUNCE_MS = 120;

/**
 * Tracks the content-box size of `element`. The first measurement is applied
 * synchronously (so dependent layout can mount immediately); later resizes are
 * debounced to avoid a repaint storm while dragging.
 */
export function useContainerSize(
  element: HTMLElement | null,
  options?: { debounceMs?: number },
): PdfViewportSize | null {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [size, setSize] = useState<PdfViewportSize | null>(null);

  useEffect(() => {
    if (!element) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let measured = false;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const next = { width: entry.contentRect.width, height: entry.contentRect.height };
      if (!measured) {
        measured = true;
        setSize(next);
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => setSize(next), debounceMs);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [element, debounceMs]);

  return size;
}
