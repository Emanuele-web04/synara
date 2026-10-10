// skip ancestors that can never report client-box metrics (clientWidth is 0 by spec: display:contents generates no box, display:inline exposes none); zero-width real boxes still count — a genuinely zero-width viewport is meaningful
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
