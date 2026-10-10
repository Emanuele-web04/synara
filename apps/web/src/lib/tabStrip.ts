// FILE: tabStrip.ts
// Purpose: Behavior shared by every horizontal tab row (right dock panes, open threads,
//          terminals, the in-app browser): which tab takes over when the active one closes,
//          and scrolling a tab into view inside its own strip.
// Layer: Web UI helpers

/**
 * Browser-style successor for a closed tab: the tab that slides into the closed slot (its
 * right neighbor), or the new last tab when the closed one was last. `remaining` is the
 * list after removal and `removedIndex` the closed tab's index before it.
 */
export function resolveTabAfterClose<T>(remaining: readonly T[], removedIndex: number): T | null {
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)] ?? null;
}

// Scroll only the strip itself (not `scrollIntoView`, which would also scroll every
// scrollable ancestor such as the dock or chat column when the strip mounts offscreen).
export function scrollTabIntoView(strip: HTMLElement, tab: HTMLElement): void {
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const left = tabRect.left - stripRect.left + strip.scrollLeft;
  const right = left + tabRect.width;
  if (left < strip.scrollLeft) {
    strip.scrollLeft = left;
  } else if (right > strip.scrollLeft + strip.clientWidth) {
    strip.scrollLeft = right - strip.clientWidth;
  }
}
