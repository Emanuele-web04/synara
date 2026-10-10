// FILE: usePdfPageRender.ts
// Purpose: Drive the imperative paint pipeline for a single PDF page — HiDPI
//          canvas render, selectable text layer, and clickable links — keyed on
//          the active flag and scale. Each pass cancels the previous one so
//          rapid zooming never races two paints onto the same canvas. While a
//          page is inactive (far from the viewport) its canvas backing store and
//          text-layer DOM are released so scrolled-through documents don't
//          accumulate per-page memory. Lets PdfPageView stay declarative
//          (refs + JSX only).
// Layer: Web PDF rendering hook
// Exports: usePdfPageRender, PdfPageRenderState

import { type RefObject, useEffect, useRef, useState } from "react";

import type { PDFDocumentProxy, PageViewport, RenderedTextLayer } from "./pdfEngine";
import { type PDFPageProxy, renderPageTextLayer } from "./pdfEngine";
import { extractPageLinks, type PdfLink } from "./pdfLinks";
import type { PdfPageIntrinsicSize } from "./pdfZoom";

export interface PdfPageRenderState {
  /** Intrinsic page size (at scale 1) once measured; null before first paint. */
  renderedSize: PdfPageIntrinsicSize | null;
  links: PdfLink[];
  /** Non-null when this page failed to paint, so the UI can surface it instead
   *  of silently showing a blank white sheet. */
  error: string | null;
}

// Hard ceiling on the canvas backing store. 4096px is a safe texture size across
// GPUs and keeps per-page paint cost bounded even when a page is zoomed large.
const MAX_CANVAS_DIMENSION = 4096;
// Above 2x the extra backing-store pixels are not perceptible for document text
// but quadruple the paint cost, so never render past it regardless of the display.
const MAX_RENDER_DPR = 2;

function resolveRenderDpr(cssWidth: number, cssHeight: number): number {
  let dpr = Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR);
  const longestSide = Math.max(cssWidth, cssHeight) * dpr;
  if (longestSide > MAX_CANVAS_DIMENSION) {
    dpr *= MAX_CANVAS_DIMENSION / longestSide;
  }
  return dpr > 0 ? dpr : 1;
}

function isRenderCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "RenderingCancelledException"
  );
}

const EMPTY_LINKS: PdfLink[] = [];

export function usePdfPageRender(input: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  isActive: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  textLayerRef: RefObject<HTMLDivElement | null>;
}): PdfPageRenderState {
  const { document: pdfDocument, pageNumber, scale, isActive, canvasRef, textLayerRef } = input;
  const pageProxyRef = useRef<{
    readonly document: PDFDocumentProxy;
    readonly pageNumber: number;
    readonly page: PDFPageProxy;
  } | null>(null);
  // Render results keyed to the (document, page) they were produced for: a
  // page/document switch derives straight back to the blank state in the same
  // render, with no state-resetting effect.
  const [pageRender, setPageRender] = useState<{
    doc: PDFDocumentProxy;
    page: number;
    renderedSize: PdfPageIntrinsicSize | null;
    links: PdfLink[];
    error: string | null;
  } | null>(null);
  const isCurrentRender =
    pageRender !== null && pageRender.doc === pdfDocument && pageRender.page === pageNumber;
  const renderedSize = isCurrentRender ? pageRender.renderedSize : null;
  // Links are cleared while the page is far from the viewport (its DOM is
  // released below); deriving keeps that without a deactivation setState.
  const links = isCurrentRender && isActive ? pageRender.links : EMPTY_LINKS;
  const error = isCurrentRender ? pageRender.error : null;

  useEffect(() => {
    pageProxyRef.current = null;
  }, [pageNumber, pdfDocument]);

  // Release the page's memory footprint while it is far from the viewport:
  // zeroing the canvas dimensions drops its backing store and clearing the text
  // layer removes its DOM. `renderedSize` is kept so the placeholder box (and
  // total scroll height) stays stable; reactivation repaints from the cached
  // page proxy. Runs after the render effect's cleanup has cancelled any
  // in-flight paint for this page.
  useEffect(() => {
    if (isActive) {
      return;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    textLayerRef.current?.replaceChildren();
  }, [isActive, canvasRef, textLayerRef]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    let textLayer: RenderedTextLayer | null = null;
    const patchRender = (patch: {
      renderedSize?: PdfPageIntrinsicSize | null;
      links?: PdfLink[];
      error?: string | null;
    }) =>
      setPageRender((current) =>
        current !== null && current.doc === pdfDocument && current.page === pageNumber
          ? { ...current, ...patch }
          : {
              doc: pdfDocument,
              page: pageNumber,
              renderedSize: null,
              links: [],
              error: null,
              ...patch,
            },
      );

    (async () => {
      try {
        const cachedPage = pageProxyRef.current;
        const page =
          cachedPage?.document === pdfDocument && cachedPage.pageNumber === pageNumber
            ? cachedPage.page
            : await pdfDocument.getPage(pageNumber);
        if (cancelled) {
          return;
        }
        pageProxyRef.current = { document: pdfDocument, pageNumber, page };
        const viewport = page.getViewport({ scale });
        patchRender({
          renderedSize: { width: viewport.width / scale, height: viewport.height / scale },
        });

        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }
        const cssWidth = viewport.width;
        const cssHeight = viewport.height;
        // Backing-store resolution is capped, not raw devicePixelRatio: at large
        // fit-width scales on a wide pane a Retina (dpr 2) page would otherwise
        // allocate a multi-megapixel canvas per page, and several paint at once on
        // open. Clamp dpr to 2 and keep the longest backing-store side within a
        // GPU-friendly ceiling so the paint cost stays bounded (CSS size, and thus
        // layout + crispness at normal zoom, is unchanged).
        const renderDpr = resolveRenderDpr(cssWidth, cssHeight);
        canvas.width = Math.ceil(cssWidth * renderDpr);
        canvas.height = Math.ceil(cssHeight * renderDpr);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;

        const deviceViewport: PageViewport = page.getViewport({ scale: scale * renderDpr });
        renderTask = page.render({ canvas, viewport: deviceViewport });
        await renderTask.promise;
        if (cancelled) {
          return;
        }
        patchRender({ error: null });

        const textContainer = textLayerRef.current;
        if (textContainer) {
          textContainer.replaceChildren();
          textContainer.style.setProperty("--scale-factor", String(scale));
          textContainer.style.width = `${cssWidth}px`;
          textContainer.style.height = `${cssHeight}px`;
          textLayer = await renderPageTextLayer({ page, viewport, container: textContainer });
          await textLayer.promise;
        }
        if (cancelled) {
          return;
        }

        const pageLinks = await extractPageLinks({ doc: pdfDocument, page, viewport });
        if (!cancelled) {
          patchRender({ links: pageLinks });
        }
      } catch (caught) {
        // A cancelled render rejects; that is expected on scale change / unmount.
        if (cancelled || isRenderCancellation(caught)) {
          return;
        }
        // A failed single page should not blank the whole document, but it also
        // must not be a silent white sheet — log it and surface a marker.
        const message = caught instanceof Error ? caught.message : "Failed to render page";
        console.error(`[pdf] failed to render page ${pageNumber}:`, caught);
        patchRender({ links: [], error: message });
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [isActive, pageNumber, pdfDocument, scale, canvasRef, textLayerRef]);

  return { renderedSize, links, error };
}
