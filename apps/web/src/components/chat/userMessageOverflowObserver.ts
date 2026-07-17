type OverflowMeasure = () => void;

const measuresByElement = new Map<Element, OverflowMeasure>();
const pendingElements = new Set<Element>();
let sharedObserver: ResizeObserver | null = null;
let pendingFrame: number | null = null;

function flushPendingMeasures(): void {
  pendingFrame = null;
  const elements = [...pendingElements];
  pendingElements.clear();
  for (const element of elements) {
    measuresByElement.get(element)?.();
  }
}

function getSharedObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") {
    return null;
  }
  sharedObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      pendingElements.add(entry.target);
    }
    if (pendingFrame === null) {
      pendingFrame = requestAnimationFrame(flushPendingMeasures);
    }
  });
  return sharedObserver;
}

export function observeUserMessageOverflow(
  element: HTMLElement,
  measure: OverflowMeasure,
): () => void {
  const observer = getSharedObserver();
  if (!observer) {
    return () => undefined;
  }

  measuresByElement.set(element, measure);
  observer.observe(element);

  return () => {
    measuresByElement.delete(element);
    pendingElements.delete(element);
    observer.unobserve(element);
    if (measuresByElement.size === 0) {
      observer.disconnect();
      sharedObserver = null;
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
      pendingElements.clear();
    }
  };
}
