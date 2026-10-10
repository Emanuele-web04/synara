import { useEffect, useRef, useState } from "react";

import { PDF_PAGE_MARGIN_PX } from "./pdfZoom";

// The current page is the last one whose top has scrolled above this fraction of the viewport height (a line 25% down from the top of the scroll area).
const CURRENT_PAGE_PROBE_RATIO = 0.25;

export interface PdfPageNavigation {
  currentPage: number;
  registerElement: (pageNumber: number, element: HTMLElement | null) => void;
  jumpToPage: (pageNumber: number) => void;
  scrollToPage: (pageNumber: number, behavior: ScrollBehavior) => void;
}

interface CurrentPageState {
  resetKey: unknown;
  page: number;
}

export function usePdfPageNavigation(input: {
  scrollRoot: HTMLElement | null;
  numPages: number;
  enabled: boolean;
  resetKey: unknown;
}): PdfPageNavigation {
  const { scrollRoot, numPages, enabled, resetKey } = input;
  const [currentPageState, setCurrentPageState] = useState<CurrentPageState>({
    resetKey,
    page: 1,
  });
  const currentPage = Object.is(currentPageState.resetKey, resetKey) ? currentPageState.page : 1;
  const pageElementsRef = useRef(new Map<number, HTMLElement>());

  const registerElement = (pageNumber: number, element: HTMLElement | null) => {
    if (element) {
      pageElementsRef.current.set(pageNumber, element);
    } else {
      pageElementsRef.current.delete(pageNumber);
    }
  };

  const scrollToPage = (pageNumber: number, behavior: ScrollBehavior) => {
    const container = scrollRoot;
    const element = pageElementsRef.current.get(pageNumber);
    if (!container || !element) {
      return;
    }
    const top =
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      PDF_PAGE_MARGIN_PX;
    container.scrollTo({ top, behavior });
  };

  useEffect(() => {
    if (!enabled) {
      return;
    }
    // a new PDF must start at top even when React reuses the viewer pane — stale scroll state can survive across files
    scrollRoot?.scrollTo({ top: 0, behavior: "auto" });
  }, [enabled, numPages, resetKey, scrollRoot]);

  const jumpToPage = (pageNumber: number) => {
    const clamped = Math.min(Math.max(pageNumber, 1), Math.max(numPages, 1));
    setCurrentPageState({ resetKey, page: clamped });
    scrollToPage(clamped, "smooth");
  };

  // page tops are monotonic in page order — scan ascending, stop at first page below the probe line: O(currentPage) per frame not O(numPages)
  useEffect(() => {
    const container = scrollRoot;
    if (!container || !enabled) {
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const containerTop = container.getBoundingClientRect().top;
      const probe = containerTop + container.clientHeight * CURRENT_PAGE_PROBE_RATIO;
      let nextPage = 1;
      for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
        const element = pageElementsRef.current.get(pageNumber);
        if (!element) {
          continue;
        }
        if (element.getBoundingClientRect().top <= probe) {
          nextPage = pageNumber;
        } else {
          break;
        }
      }
      setCurrentPageState({ resetKey, page: nextPage });
    };
    const onScroll = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(update);
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [enabled, numPages, resetKey, scrollRoot]);

  return { currentPage, registerElement, jumpToPage, scrollToPage };
}
