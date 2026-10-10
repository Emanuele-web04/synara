// FILE: usePdfZoomController.ts
// Purpose: Own the PDF viewer's zoom state and the scale it resolves to for the
//          current layout. Handles the +/- steppers, explicit percentages, and
//          fit-width/fit-page modes, and re-anchors the reader's page after a
//          zoom-driven rescale.
// Layer: Web PDF rendering hook
// Exports: usePdfZoomController, PdfZoomController

import { useEffect, useRef, useState } from "react";

import {
  clampPdfScale,
  nextZoomScale,
  type PdfPageIntrinsicSize,
  type PdfViewportSize,
  type PdfZoomMode,
  previousZoomScale,
  resolvePdfScale,
} from "./pdfZoom";

export interface PdfZoomController {
  zoomMode: PdfZoomMode;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetScale: (scale: number) => void;
  onFitWidth: () => void;
  onFitPage: () => void;
}

export function usePdfZoomController(input: {
  firstPageSize: PdfPageIntrinsicSize | null;
  containerSize: PdfViewportSize | null;
  /** The page to re-anchor to after a user-initiated zoom. */
  currentPage: number;
  scrollToPage: (pageNumber: number, behavior: ScrollBehavior) => void;
}): PdfZoomController {
  const { firstPageSize, containerSize, currentPage, scrollToPage } = input;
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>({ type: "fit-width" });
  // When the user zooms we re-anchor to the page they were on so the content
  // does not jump; resize-driven rescales intentionally leave this unset.
  const restorePageRef = useRef<number | null>(null);

  const scale = resolvePdfScale(zoomMode, firstPageSize, containerSize);

  // After a zoom-driven rescale, restore the anchored page instantly. This is a
  // one-way restore: it never feeds back into the scroll-position tracker.
  useEffect(() => {
    if (restorePageRef.current != null) {
      scrollToPage(restorePageRef.current, "auto");
      restorePageRef.current = null;
    }
  }, [scale, scrollToPage]);

  const anchorBeforeZoom = () => {
    restorePageRef.current = currentPage;
  };

  const onZoomIn = () => {
    anchorBeforeZoom();
    setZoomMode({ type: "custom", scale: nextZoomScale(scale) });
  };

  const onZoomOut = () => {
    anchorBeforeZoom();
    setZoomMode({ type: "custom", scale: previousZoomScale(scale) });
  };

  const onSetScale = (nextScale: number) => {
    anchorBeforeZoom();
    setZoomMode({ type: "custom", scale: clampPdfScale(nextScale) });
  };

  const onFitWidth = () => {
    anchorBeforeZoom();
    setZoomMode({ type: "fit-width" });
  };

  const onFitPage = () => {
    anchorBeforeZoom();
    setZoomMode({ type: "fit-page" });
  };

  return { zoomMode, scale, onZoomIn, onZoomOut, onSetScale, onFitWidth, onFitPage };
}
