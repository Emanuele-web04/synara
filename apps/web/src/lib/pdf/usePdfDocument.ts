// FILE: usePdfDocument.ts
// Purpose: React hook that fetches a PDF's bytes from the allowlisted local-file
//          route, loads it through the pdf.js engine, and exposes the document
//          proxy plus first-page size for layout. Owns cancellation + teardown so
//          switching files never leaks a worker-backed document.
// Layer: Web PDF rendering hook
// Exports: usePdfDocument, PdfDocumentState

import { useEffect, useState } from "react";

import { loadPdfDocument, type PDFDocumentProxy } from "./pdfEngine";
import type { PdfPageIntrinsicSize } from "./pdfZoom";

export type PdfDocumentStatus = "loading" | "ready" | "error";

export interface PdfDocumentState {
  status: PdfDocumentStatus;
  document: PDFDocumentProxy | null;
  numPages: number;
  /** Size of page 1 at scale 1, used to lay out the scroll area before render. */
  firstPageSize: PdfPageIntrinsicSize | null;
  error: string | null;
}

const INITIAL_STATE: PdfDocumentState = {
  status: "loading",
  document: null,
  numPages: 0,
  firstPageSize: null,
  error: null,
};

export function usePdfDocument(url: string): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PDFDocumentProxy | null = null;
    const abortController = new AbortController();
    setState(INITIAL_STATE);

    (async () => {
      try {
        const response = await fetch(url, { signal: abortController.signal });
        if (!response.ok) {
          throw new Error(`Failed to load PDF (${response.status})`);
        }
        const bytes = await response.arrayBuffer();
        if (cancelled) {
          return;
        }
        const document = await loadPdfDocument(bytes);
        loadedDocument = document;
        if (cancelled) {
          void document.destroy();
          return;
        }
        const firstPage = await document.getPage(1);
        const viewport = firstPage.getViewport({ scale: 1 });
        if (cancelled) {
          void document.destroy();
          return;
        }
        setState({
          status: "ready",
          document,
          numPages: document.numPages,
          firstPageSize: { width: viewport.width, height: viewport.height },
          error: null,
        });
      } catch (error) {
        if (cancelled || abortController.signal.aborted) {
          return;
        }
        if (loadedDocument) {
          void loadedDocument.destroy();
          loadedDocument = null;
        }
        setState({
          status: "error",
          document: null,
          numPages: 0,
          firstPageSize: null,
          error: error instanceof Error ? error.message : "Could not open this PDF.",
        });
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
      if (loadedDocument) {
        void loadedDocument.destroy();
      }
    };
  }, [url]);

  return state;
}
