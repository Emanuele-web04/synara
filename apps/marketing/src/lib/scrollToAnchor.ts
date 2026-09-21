"use client";

// smooth (or instant under reduced-motion) anchor jump + URL hash sync without a history entry; returns false when the element doesn't exist so the native jump can still handle it
export function scrollToAnchor(anchor: string, event?: { preventDefault: () => void }): boolean {
  const target = document.getElementById(anchor);
  if (!target) return false;
  event?.preventDefault();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "start",
  });
  history.replaceState(null, "", `#${anchor}`);
  return true;
}
