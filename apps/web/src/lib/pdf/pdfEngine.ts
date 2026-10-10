// centralizing worker setup + dynamic import keeps pdf.js out of the main bundle and gives one place to tune options (matching how Codex vendors a custom pdf.js viewer)
// deliberately the LEGACY pdfjs-dist build: the modern build assumes TC39 Map.prototype.getOrInsertComputed with no polyfill — Electron's Chromium lacks it and page render throws; legacy bundles core-js polyfills so engine+worker must both come from it and stay version-matched

// Vite emits the worker as a standalone asset — the import is tiny and the ~1MB worker only fetches when pdf.js spins it up; this bundling survives Electron packaging
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

export type { PDFDocumentProxy, PDFPageProxy, PageViewport };

type PdfjsModule = typeof import("pdfjs-dist");

let modulePromise: Promise<PdfjsModule> | null = null;

// one shared import+worker assignment for the app — later callers await the same promise
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs as unknown as PdfjsModule;
    });
  }
  return modulePromise;
}

/**
 * Loads a PDF from in-memory bytes (we fetch the file ourselves rather than
 * letting pdf.js range-request a URL, which keeps the same-origin auth token +
 * Electron custom-protocol path simple and reliable).
 */
export async function loadPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data });
  return task.promise;
}

export interface RenderedTextLayer {
  promise: Promise<void>;
  cancel: () => void;
}

/**
 * Renders the selectable text layer for a page into `container`. The container
 * must carry the `--scale-factor` CSS var (the `.pdf-viewer-page` rule sets it)
 * so pdf.js positions the transparent text runs over the canvas.
 */
export async function renderPageTextLayer(options: {
  page: PDFPageProxy;
  viewport: PageViewport;
  container: HTMLElement;
}): Promise<RenderedTextLayer> {
  const pdfjs = await loadPdfjs();
  const textLayer = new pdfjs.TextLayer({
    textContentSource: options.page.streamTextContent({ includeMarkedContent: true }),
    container: options.container,
    viewport: options.viewport,
  });
  return { promise: textLayer.render(), cancel: () => textLayer.cancel() };
}
