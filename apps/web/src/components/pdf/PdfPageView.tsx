// FILE: PdfPageView.tsx
// Purpose: Render a single PDF page for the in-app viewer: a HiDPI canvas plus a
//          selectable text layer and a clickable link layer. Virtualized — the
//          page only loads + paints when it scrolls near the viewport, and keeps
//          its placeholder box sized so the scroll height (and page indicator)
//          stay correct before paint. The paint pipeline lives in
//          usePdfPageRender; this component owns activation + layout markup.
// Layer: Web PDF rendering component
// Exports: PdfPageView

import { memo, useEffect, useRef, useState } from "react";

import type { PDFDocumentProxy } from "~/lib/pdf/pdfEngine";
import type { PdfLink } from "~/lib/pdf/pdfLinks";
import { usePdfPageRender } from "~/lib/pdf/usePdfPageRender";
import type { PdfPageIntrinsicSize } from "~/lib/pdf/pdfZoom";
import { openExternalLink } from "~/lib/linkChips";

// Prerender pages within roughly one viewport above/below so scrolling reveals
// already-painted pages instead of blank boxes.
const PAGE_PRERENDER_ROOT_MARGIN = "150% 0px";

interface PdfPageViewProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  /** Page size at scale 1, used to size the placeholder before the page paints. */
  intrinsicSize: PdfPageIntrinsicSize;
  /** Scroll container used as the IntersectionObserver root. */
  scrollRoot: HTMLElement | null;
  registerElement: (pageNumber: number, element: HTMLElement | null) => void;
  onJumpToPage: (pageNumber: number) => void;
}

export const PdfPageView = memo(function PdfPageView({
  document: pdfDocument,
  pageNumber,
  scale,
  intrinsicSize,
  scrollRoot,
  registerElement,
  onJumpToPage,
}: PdfPageViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [isActive, setIsActive] = useState(false);

  // Report the element to the orchestrator so it can map scroll offset -> page.
  useEffect(() => {
    const element = wrapperRef.current;
    registerElement(pageNumber, element);
    return () => registerElement(pageNumber, null);
  }, [pageNumber, registerElement]);

  // Activate (and keep active) once the page nears the viewport.
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || isActive) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsActive(true);
        }
      },
      { root: scrollRoot, rootMargin: PAGE_PRERENDER_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isActive, scrollRoot]);

  const { renderedSize, links, error } = usePdfPageRender({
    document: pdfDocument,
    pageNumber,
    scale,
    isActive,
    canvasRef,
    textLayerRef,
  });

  const layoutSize = renderedSize ?? intrinsicSize;
  const width = layoutSize.width * scale;
  const height = layoutSize.height * scale;

  return (
    <div
      ref={wrapperRef}
      className="pdf-viewer-page"
      data-page-number={pageNumber}
      style={{ width: `${width}px`, height: `${height}px` }}
    >
      <canvas
        ref={canvasRef}
        className="pdf-viewer-page__canvas"
        aria-label={`Page ${pageNumber}`}
      />
      <div
        ref={textLayerRef}
        className="pdf-viewer-page__text-layer textLayer"
        aria-hidden="true"
      />
      {links.length > 0 ? (
        <div className="pdf-viewer-page__link-layer">
          {links.map((link) => (
            <PdfLinkAnchor key={link.id} link={link} onJumpToPage={onJumpToPage} />
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="pdf-viewer-page__error" role="alert">
          <span>Could not render page {pageNumber}</span>
          <span className="pdf-viewer-page__error-detail">{error}</span>
        </div>
      ) : null}
    </div>
  );
});

function PdfLinkAnchor({
  link,
  onJumpToPage,
}: {
  link: PdfLink;
  onJumpToPage: (pageNumber: number) => void;
}) {
  const style = {
    left: `${link.left}px`,
    top: `${link.top}px`,
    width: `${link.width}px`,
    height: `${link.height}px`,
  } as const;

  const url = link.url;
  if (url) {
    return (
      <a
        className="pdf-viewer-page__link"
        style={style}
        href={url}
        title={url}
        onClick={(event) => {
          event.preventDefault();
          openExternalLink(url);
        }}
      >
        <span className="sr-only">{url}</span>
      </a>
    );
  }

  return (
    <button
      type="button"
      className="pdf-viewer-page__link"
      style={style}
      aria-label={`Go to page ${link.targetPageNumber}`}
      onClick={() => {
        if (link.targetPageNumber != null) {
          onJumpToPage(link.targetPageNumber);
        }
      }}
    />
  );
}
