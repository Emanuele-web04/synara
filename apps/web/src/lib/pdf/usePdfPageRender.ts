import { type RefObject, useEffect, useRef, useState } from "react";

import type { PDFDocumentProxy, PageViewport, RenderedTextLayer } from "./pdfEngine";
import { type PDFPageProxy, renderPageTextLayer } from "./pdfEngine";
import { extractPageLinks, type PdfLink } from "./pdfLinks";
import type { PdfPageIntrinsicSize } from "./pdfZoom";

export interface PdfPageRenderState {
  renderedSize: PdfPageIntrinsicSize | null;
  links: PdfLink[];
  error: string | null;
}

// 4096px is a safe texture size across GPUs and keeps per-page paint cost bounded when zoomed large
const MAX_CANVAS_DIMENSION = 4096;
// past 2x the extra pixels aren't perceptible for text but quadruple paint cost — never render past it
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
  // results keyed to (document, page) — a switch derives back to blank state in the same render, no state-resetting effect
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
  // Links are cleared while the page is far from the viewport (its DOM is released below); deriving keeps that without a deactivation setState.
  const links = isCurrentRender && isActive ? pageRender.links : EMPTY_LINKS;
  const error = isCurrentRender ? pageRender.error : null;

  useEffect(() => {
    pageProxyRef.current = null;
  }, [pageNumber, pdfDocument]);

  // zeroing canvas dims drops the backing store and clearing the text layer removes its DOM while far from viewport; renderedSize is kept so scroll height stays stable; runs after the render effect cancels in-flight paint
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
        // cap backing-store resolution not raw dpr — Retina pages at large fit-width would allocate multi-megapixel canvases, several painting at once on open; clamp dpr to 2 and bound the longest side (CSS size/layout unchanged)
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
        // A failed single page should not blank the whole document, but it also must not be a silent white sheet — log it and surface a marker.
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
