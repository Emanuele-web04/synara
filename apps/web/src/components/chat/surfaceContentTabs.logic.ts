// FILE: surfaceContentTabs.logic.ts
// Purpose: Pure geometry for the content tab strip's overflow menu.
// Layer: Chat surface UI logic

interface HorizontalSpan {
  left: number;
  right: number;
}

// Sub-pixel layout can leave a fully shown tab a fraction past the strip's edge.
const VISIBILITY_TOLERANCE_PX = 1;

/** Indexes of the tabs that are not wholly inside the strip's visible span. */
export function findHiddenSurfaceTabIndexes(
  strip: HorizontalSpan,
  tabs: readonly HorizontalSpan[],
): number[] {
  const hidden: number[] = [];
  tabs.forEach((tab, index) => {
    if (
      tab.left < strip.left - VISIBILITY_TOLERANCE_PX ||
      tab.right > strip.right + VISIBILITY_TOLERANCE_PX
    ) {
      hidden.push(index);
    }
  });
  return hidden;
}
