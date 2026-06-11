// FILE: BrowserPanel.overlay.ts
// Purpose: Pure DOM/overlay-occlusion, bounds-sync, and perf helpers extracted from BrowserPanel.
// Layer: Desktop-only browser-panel support (no React)
// Exports: BrowserViewportPerfCounters, BrowserWebviewElement, VIEWPORT_TRANSITION_PROPERTIES,
//   bounds/perf/webview constants, closeButtonClassName, formatBrowserActionError,
//   ignoreBrowserBoundsSyncError, setBrowserWebviewOverlayOcclusion,
//   hasNativeBrowserObscuringOverlay, isNativeBrowserTransitionSignalTarget,
//   isBrowserPerfLoggingEnabled

import { cn } from "~/lib/utils";

export const BROWSER_BOUNDS_SYNC_BURST_FRAMES = 30;
export const BROWSER_BOUNDS_SYNC_STABLE_FRAME_TARGET = 2;
export const BROWSER_WEBVIEW_PARTITION = "persist:synara-browser";
export const BROWSER_BLANK_URL = "about:blank";
export const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
export const SYNARA_BROWSER_LABEL = "Synara browser";

const NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR = [
  "[data-slot='dialog-backdrop']",
  "[data-slot='dialog-popup']",
  "[data-slot='dialog-viewport']",
  "[data-slot='alert-dialog-backdrop']",
  "[data-slot='alert-dialog-popup']",
  "[data-slot='alert-dialog-viewport']",
  "[data-slot='command-dialog-backdrop']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='command-dialog-viewport']",
  "[data-slot='toast-popup']",
  "[role='dialog'][aria-modal='true']",
].join(", ");

// The browser itself lives inside a sheet, and toast portals/positioners are just
// layout containers. Treating either as blockers hides the WebContentsView.
const NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR = [
  "[data-panel-resize-overlay='true']",
  "[data-slot='sheet-backdrop']",
  "[data-slot='sheet-popup']",
  "[data-slot='toast-portal']",
  "[data-slot='toast-portal-anchored']",
  "[data-slot='toast-viewport']",
  "[data-slot='toast-viewport-anchored']",
  "[data-slot='toast-positioner']",
].join(", ");

export interface BrowserViewportPerfCounters {
  syncAttempts: number;
  syncSkips: number;
  syncSends: number;
  resizeSchedules: number;
  resizeScheduleSkips: number;
  burstStarts: number;
  burstExtensions: number;
  burstFrames: number;
  transitionSignals: number;
  ignoredTransitionSignals: number;
}

export interface BrowserWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
}

export function createBrowserViewportPerfCounters(): BrowserViewportPerfCounters {
  return {
    syncAttempts: 0,
    syncSkips: 0,
    syncSends: 0,
    resizeSchedules: 0,
    resizeScheduleSkips: 0,
    burstStarts: 0,
    burstExtensions: 0,
    burstFrames: 0,
    transitionSignals: 0,
    ignoredTransitionSignals: 0,
  };
}

export const VIEWPORT_TRANSITION_PROPERTIES = new Set([
  "transform",
  "translate",
  "scale",
  "rotate",
  "width",
  "max-width",
  "min-width",
  "height",
  "max-height",
  "min-height",
  "left",
  "right",
  "top",
  "bottom",
  "inset",
  "inset-inline",
  "inset-inline-start",
  "inset-inline-end",
  "inset-block",
  "inset-block-start",
  "inset-block-end",
]);

export function closeButtonClassName(isActive: boolean) {
  return cn(
    "ml-1 size-5 shrink-0 rounded-sm p-0 text-muted-foreground/70 hover:bg-background/80 hover:text-foreground",
    isActive ? "hover:bg-background" : "hover:bg-card",
  );
}

export function formatBrowserActionError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return "Couldn't complete that browser action.";
  }
  if (/ERR_ABORTED|\(-3\)/i.test(error.message)) {
    return null;
  }
  return "Couldn't complete that browser action.";
}

export function ignoreBrowserBoundsSyncError(): void {
  // Bounds sync is best-effort plumbing between the React shell and the native
  // browser surface. Avoid surfacing transient geometry-sync failures as user-facing
  // browser errors because they do not reflect page navigation health.
}

export function setBrowserWebviewOverlayOcclusion(
  webview: BrowserWebviewElement | null,
  occluded: boolean,
): void {
  if (!webview) {
    return;
  }
  webview.style.visibility = occluded ? "hidden" : "visible";
  webview.style.pointerEvents = occluded ? "none" : "auto";
}

function isVisibleOverlayElement(element: HTMLElement): boolean {
  const styles = window.getComputedStyle(element);
  if (styles.display === "none" || styles.visibility === "hidden" || styles.opacity === "0") {
    return false;
  }
  return element.getClientRects().length > 0;
}

function isNativeBrowserNonObscuringOverlayElement(element: HTMLElement): boolean {
  return (
    element.closest("[data-slot='toast-popup']") === null &&
    element.closest(NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR) !== null
  );
}

const NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
] as const;

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function candidateObscuresNativeBrowser(candidate: HTMLElement, element: HTMLElement): boolean {
  if (candidate === element || candidate.contains(element) || element.contains(candidate)) {
    return false;
  }
  if (!isVisibleOverlayElement(candidate)) {
    return false;
  }

  const elementRect = element.getBoundingClientRect();
  const candidateRects = candidate.getClientRects();
  for (const candidateRect of candidateRects) {
    if (rectsIntersect(elementRect, candidateRect)) {
      return true;
    }
  }

  return false;
}

function hasTopLayerDomObstruction(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  for (const [xRatio, yRatio] of NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS) {
    const x = rect.left + rect.width * xRatio;
    const y = rect.top + rect.height * yRatio;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      continue;
    }

    const hitElements = document.elementsFromPoint(x, y);
    for (const hitElement of hitElements) {
      if (!(hitElement instanceof HTMLElement)) {
        continue;
      }
      if (hitElement === element || element.contains(hitElement) || hitElement.contains(element)) {
        continue;
      }
      if (isNativeBrowserNonObscuringOverlayElement(hitElement)) {
        continue;
      }
      if (!isVisibleOverlayElement(hitElement)) {
        continue;
      }
      return true;
    }
  }

  return false;
}

export function hasNativeBrowserObscuringOverlay(element: HTMLElement): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(
    NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR,
  );
  for (const candidate of candidates) {
    if (candidateObscuresNativeBrowser(candidate, element)) {
      return true;
    }
  }

  return hasTopLayerDomObstruction(element);
}

export function isNativeBrowserTransitionSignalTarget(
  target: EventTarget | null,
  viewportElement: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (viewportElement.contains(target) || target.contains(viewportElement)) {
    return true;
  }

  return (
    target.closest(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) !== null ||
    target.closest("[data-slot='sidebar-container']") !== null ||
    target.closest("[data-slot='sheet-popup']") !== null
  );
}

export function isBrowserPerfLoggingEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return (
      window.localStorage.getItem("synara:browser-perf") === "1" ||
      window.localStorage.getItem("dpcode:browser-perf") === "1" ||
      window.localStorage.getItem("t3code:browser-perf") === "1"
    );
  } catch {
    return false;
  }
}
