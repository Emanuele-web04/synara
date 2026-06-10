// Purpose: Own the full-screen expanded-image lightbox state for the chat
//   transcript, including keyboard navigation (Escape/Arrow keys).
// Layer: web / chat composer-adjacent UI hook.
// Exports: useExpandedImagePreview.
import { useCallback, useEffect, useState } from "react";

import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";

export interface UseExpandedImagePreviewResult {
  readonly expandedImage: ExpandedImagePreview | null;
  readonly expandedImageItem: ExpandedImageItem | null;
  readonly openExpandedImage: (preview: ExpandedImagePreview) => void;
  readonly closeExpandedImage: () => void;
  readonly navigateExpandedImage: (direction: -1 | 1) => void;
  readonly resetExpandedImage: () => void;
}

export function useExpandedImagePreview(): UseExpandedImagePreviewResult {
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const openExpandedImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);

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

  const resetExpandedImage = useCallback(() => {
    setExpandedImage(null);
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const expandedImageItem = expandedImage
    ? (expandedImage.images[expandedImage.index] ?? null)
    : null;

  return {
    expandedImage,
    expandedImageItem,
    openExpandedImage,
    closeExpandedImage,
    navigateExpandedImage,
    resetExpandedImage,
  };
}
