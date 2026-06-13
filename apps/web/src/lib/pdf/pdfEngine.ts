// FILE: pdfEngine.ts
// Purpose: Single entry point to pdf.js (pdfjs-dist) for the in-app PDF viewer.
//          Lazy-loads the heavy engine on first use, configures the bundled
//          worker exactly once, and exposes the few primitives the viewer needs
//          (document load, text-layer render) so call sites never import
//          pdfjs-dist directly.
// Layer: Web PDF rendering utility
// Exports: loadPdfDocument, renderPageTextLayer, types re-exported from pdfjs-dist
// Why: Centralizing the worker setup + dynamic import keeps pdf.js out of the
//      main bundle (only fetched when a PDF is opened) and gives us one place to
//      tune engine options, matching how Codex vendors a custom pdf.js viewer.
//
// We deliberately use the *legacy* pdfjs-dist build. The modern build assumes
// the JS engine implements the very recent TC39 "upsert" proposal
// (Map.prototype.getOrInsertComputed) and ships no polyfill, so on Electron's
// Chromium — which doesn't have it yet — page render throws
// "#methodPromises.getOrInsertComputed is not a function". The legacy build
// bundles the core-js polyfills, so the engine + worker must both come from it
// and stay version-matched.

// Vite emits the worker as a standalone asset and hands back its URL; the import
// itself is tiny (a string) and the ~1MB worker is only fetched when pdf.js
// spins it up. Bundling it this way is what survives Electron packaging.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

export type { PDFDocumentProxy, PDFPageProxy, PageViewport };

type PdfjsModule = typeof import("pdfjs-dist");

let modulePromise: Promise<PdfjsModule> | null = null;

// One shared import + worker assignment for the whole app. Subsequent callers
// await the same promise instead of re-importing the engine.
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
