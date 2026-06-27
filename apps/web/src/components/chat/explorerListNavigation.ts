// FILE: explorerListNavigation.ts
// Purpose: Arrow-key roving focus across the workspace explorer rows (file tree
//          + search results) so ArrowUp/ArrowDown walk the visible items one by
//          one, in display order — folders (open or closed) and files alike —
//          and keep the focused row scrolled into view.
// Layer: Chat workspace-browsing UI primitives
// Exports: EXPLORER_ROW_PROPS, useExplorerListNavigation

import { type KeyboardEvent as ReactKeyboardEvent, useCallback } from "react";

// Tree rows and search-result rows tag themselves with this so the navigator can
// collect them in DOM (= visual) order without knowing the tree's shape or which
// directories are currently expanded/loaded.
export const EXPLORER_ROW_PROPS = { "data-explorer-row": "" } as const;
const EXPLORER_ROW_SELECTOR = "[data-explorer-row]";

type ExplorerNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * Target row index for a navigation key, given the currently focused row index
 * (`-1` when focus is outside the list) and the number of rows. Down/Up clamp at
 * the ends; from outside, Down enters at the top and Up at the bottom. Pure so it
 * can be unit-tested without a DOM.
 */
export function nextExplorerRowIndex(
  key: ExplorerNavigationKey,
  currentIndex: number,
  rowCount: number,
): number {
  switch (key) {
    case "ArrowDown":
      return currentIndex < 0 ? 0 : Math.min(currentIndex + 1, rowCount - 1);
    case "ArrowUp":
      return currentIndex < 0 ? rowCount - 1 : Math.max(currentIndex - 1, 0);
    case "Home":
      return 0;
    case "End":
      return rowCount - 1;
  }
}

function isTextEntryElement(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function focusExplorerRow(row: HTMLElement): void {
  row.focus();
  // `nearest` keeps the active row on screen while scrolling as little as possible.
  // Optional-chained so a non-browser env (node/jsdom tests) that omits the method
  // can't throw — focus is the part that matters.
  row.scrollIntoView?.({ block: "nearest" });
}

/**
 * Returns an `onKeyDown` handler for the explorer panel. It moves focus between
 * the rendered rows on ArrowUp/ArrowDown/Home/End, leaving Enter/Space to the
 * rows' native `<button>` activation (open file / toggle folder). From the
 * search box, ArrowDown dips into the list while caret keys stay with the input.
 */
export function useExplorerListNavigation() {
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const { key } = event;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") {
      return;
    }
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(EXPLORER_ROW_SELECTOR),
    );
    if (rows.length === 0) {
      return;
    }

    const active = document.activeElement;
    let target: HTMLElement | undefined;
    if (isTextEntryElement(active)) {
      // Only ArrowDown enters the list; ArrowUp/Home/End keep editing the query.
      if (key !== "ArrowDown") {
        return;
      }
      target = rows[0];
    } else {
      const currentIndex = active instanceof HTMLElement ? rows.indexOf(active) : -1;
      target = rows[nextExplorerRowIndex(key, currentIndex, rows.length)];
    }

    if (!target) {
      return;
    }
    event.preventDefault();
    focusExplorerRow(target);
  }, []);
}
