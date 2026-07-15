// FILE: domLayout.ts
// Purpose: Shared DOM layout-measurement helpers for panel/resize probes.
// Layer: Web DOM utilities (no React, no app state).

// Finds the nearest ancestor that owns a real, measurable CSS box.
// Skips ancestors that can never report client-box metrics (`clientWidth` is 0
// by spec for them regardless of layout):
// - `display: contents` — participates in the tree but generates no box.
// - `display: inline` — inline boxes expose no client width/height.
// Ancestors with a real box are returned even at zero width: a genuinely
// zero-width viewport is a meaningful measurement, not a wrapper artifact.
export function findNearestMeasurableAncestor(element: HTMLElement): HTMLElement | null {
  let candidate = element.parentElement;
  while (candidate !== null) {
    const display = window.getComputedStyle(candidate).display;
    if (display !== "contents" && display !== "inline") {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}
