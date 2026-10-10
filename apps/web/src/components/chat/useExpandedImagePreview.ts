// FILE: useExpandedImagePreview.ts
// Purpose: Shared state and keyboard handling for the fullscreen image preview overlay.
// Layer: Chat and composer UI hook
// Exports: useExpandedImagePreview

import { useCallback, useEffect, useState } from "react";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";

export function useExpandedImagePreview() {
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    // Consume Escape before a containing dialog handles it and discards its draft.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  return { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage };
}
