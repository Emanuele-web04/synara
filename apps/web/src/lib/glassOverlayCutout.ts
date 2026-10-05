// FILE: glassOverlayCutout.ts
// Purpose: On a translucent window, cuts the page out from under floating overlays so a
//          translucent menu, picker, or toast shows the window's glass rather than
//          the text it covers.
// Layer: Desktop window material helper
// Exports: installGlassOverlayCutout, registerInPageGlassOverlay, computedColorAlpha
//
// A backdrop blur cannot hide what sits behind an element over a see-through region:
// Chromium composites the blurred copy over the sharp original, so text stays readable
// through a thin fill. Overlays are portaled next to the app root, so the root can instead be
// clipped with one hole per overlay; behind each hole only the window's coat and the natively
// blurred desktop remain. Paint-only: it never changes layout, hit-testing of the overlay, or
// scroll position.

import { FLOATING_OVERLAY_SURFACE_CLASS_NAME } from "~/surfaceStyles";

// Hover cards appear on every row crossing. Re-clipping the entire app for each one
// changes its compositing while the pointer moves; give them a dense fill in index.css
// instead, without touching the page's clip or hit-testing.
const HOVER_OVERLAY_SELECTOR = '[data-slot="tooltip-popup"], [data-slot="preview-card-popup"]';

/** Portaled overlays (rendered outside the app root): the root is cut out from under them. */
const OVERLAY_SELECTOR = `:is(.${FLOATING_OVERLAY_SURFACE_CLASS_NAME}, .composer-picker-menu-surface, .chat-composer-surface):not(${HOVER_OVERLAY_SELECTOR})`;

/** An overlay fading in or out is cut out only once it covers more than it reveals. */
const MIN_OVERLAY_OPACITY = 0.5;

/**
 * Frames to keep reading after the last covering overlay is gone. Some overlays stay mounted
 * while hidden (kept-mounted tooltips), so "nothing mounted" never arrives; this lets the loop
 * stop anyway, and outlasts a fade so it does not stop halfway through one.
 */
const IDLE_FRAMES_BEFORE_STOP = 30;

/**
 * Set on a portaled overlay that sits on another portaled layer instead of on the page: a
 * select or tooltip inside a dialog, a menu opened from a popover. That layer is not part of
 * the root, so it cannot be cut out from under the overlay, and the overlay's thin fill would
 * leave it readable. index.css gives a backed overlay a near-opaque fill instead.
 */
const BACKED_OVERLAY_ATTRIBUTE = "data-glass-backed";

/** Backing per showing overlay, read once when it appears rather than every frame. */
const backedOverlays = new WeakMap<HTMLElement, boolean>();

/** Alpha of a computed CSS color (`rgb()`, `rgba()`, or a `color()`/`oklab()` with `/ a`). */
export function computedColorAlpha(color: string): number {
  if (color === "transparent") return 0;
  const match = color.startsWith("rgba(")
    ? color.match(/,\s*([\d.]+)\s*\)$/)
    : color.match(/\/\s*([\d.]+)\s*\)$/);
  return match ? Number(match[1]) : 1;
}

/** A layer counts as backing only if it paints: an invisible click-catcher does not. */
const MIN_BACKING_ALPHA = 0.5;

/**
 * Whether the first painted thing under the overlay's centre is another portaled layer.
 * The overlay's own subtree and its ancestors (positioner, portal container) are skipped, and
 * so is anything unpainted, such as the transparent backdrop a modal menu puts behind itself.
 */
function isBackedByPortaledLayer(overlay: HTMLElement, root: HTMLElement): boolean {
  const rect = overlay.getBoundingClientRect();
  const stack = document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  for (const element of stack) {
    // Ancestors include the body, whose coat must never count as a backing layer.
    if (overlay.contains(element) || element.contains(overlay)) continue;
    if (root.contains(element)) return false;
    const style = getComputedStyle(element);
    if (
      style.backgroundImage !== "none" ||
      computedColorAlpha(style.backgroundColor) >= MIN_BACKING_ALPHA
    ) {
      return true;
    }
  }
  return false;
}

interface CutoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

/** Two decimals: sub-pixel precision without long float tails in the path string. */
function n(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundedRectPath(rect: CutoutRect): string {
  const { x, y, width: w, height: h } = rect;
  const r = Math.max(0, Math.min(rect.radius, w / 2, h / 2));
  return [
    `M${n(x + r)} ${n(y)}`,
    `H${n(x + w - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}`,
    `V${n(y + h - r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}`,
    `H${n(x + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}`,
    `V${n(y + r)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}`,
    "Z",
  ].join(" ");
}

/** Full box with one rounded hole; separate inverse clips are intersected for multiple holes. */
function inverseRectPath(width: number, height: number, rect: CutoutRect): string {
  return `M0 0 H${Math.ceil(width)} V${Math.ceil(height)} H0 Z ${roundedRectPath(rect)}`;
}

function isCoveringOverlay(element: HTMLElement): boolean {
  if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  return Number(getComputedStyle(element).opacity) >= MIN_OVERLAY_OPACITY;
}

function cutoutRectWithin(element: HTMLElement, box: DOMRect): CutoutRect {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x - box.x,
    y: rect.y - box.y,
    width: rect.width,
    height: rect.height,
    radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
  };
}

// ─── In-page overlays ────────────────────────────────────────────────────────────
// A raised surface that floats over content from inside the page (a floating side panel, the
// PR composer) cannot be cut out of the root: the hole would take the surface with it. Its
// wrapper registers here instead, and the content next to it (the wrapper's siblings) gets
// the hole. Only on a whole-window glass shell; elsewhere those surfaces sit on opaque content.

/** The raised surface inside a registered wrapper. */
const IN_PAGE_SURFACE_SELECTOR = ".chat-raised-panel-surface, .chat-composer-surface";

const inPageOverlayWrappers = new Set<HTMLElement>();
let cutoutId = 0;
let scheduleInstalledCutout: (() => void) | null = null;

/**
 * Registers the wrapper of an in-page overlay; the content beside it is cut out from under
 * its raised surface while it stays registered. Returns the unregister function.
 */
export function registerInPageGlassOverlay(wrapper: HTMLElement): () => void {
  inPageOverlayWrappers.add(wrapper);
  const observer = new MutationObserver(() => scheduleInstalledCutout?.());
  // Side-panel visibility changes on the host. Hidden Git/preview content updates
  // must not restart the frame loop; visible surfaces are already measured every frame.
  observer.observe(wrapper, { attributes: true, attributeFilter: ["aria-hidden"] });
  scheduleInstalledCutout?.();
  return () => {
    observer.disconnect();
    inPageOverlayWrappers.delete(wrapper);
    scheduleInstalledCutout?.();
  };
}

/**
 * Keeps page content clipped around every open overlay while the window is translucent.
 * Returns a disposer. Idle cost is one MutationObserver on the body's direct children plus
 * one per portal container; the per-frame work only runs while an overlay is showing.
 */
export function installGlassOverlayCutout(root: HTMLElement): () => void {
  const documentElement = document.documentElement;
  const observedContainers = new WeakSet<Node>();
  type CutoutBox = { width: number; height: number; rects: CutoutRect[] };
  const applied = new Map<
    HTMLElement,
    {
      previous: string;
      signature: string;
      definitions?: SVGGElement;
    }
  >();
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:fixed;width:0;height:0;pointer-events:none";
  const defs = document.createElementNS(svgNamespace, "defs");
  svg.append(defs);
  let frame: number | null = null;
  let idleFrames = 0;

  const applyClipPaths = (next: Map<HTMLElement, CutoutBox>) => {
    for (const [element, state] of applied) {
      if (next.has(element)) continue;
      element.style.clipPath = state.previous;
      state.definitions?.remove();
      applied.delete(element);
    }
    for (const [element, box] of next) {
      const signature = JSON.stringify(box);
      const state = applied.get(element) ?? { previous: element.style.clipPath, signature: "" };
      if (state.signature === signature) continue;
      state.signature = signature;
      state.definitions?.remove();
      if (box.rects.length === 1) {
        element.style.clipPath = `path(evenodd, "${inverseRectPath(box.width, box.height, box.rects[0]!)}")`;
      } else {
        // Even-odd holes in one path XOR where overlays overlap. Intersect individual
        // inverse clips instead, so their shared area stays hidden too.
        if (!svg.isConnected) document.body.append(svg);
        const group = document.createElementNS(svgNamespace, "g");
        const prefix = `glass-cutout-${++cutoutId}`;
        for (const [index, rect] of box.rects.entries()) {
          const clip = document.createElementNS(svgNamespace, "clipPath");
          clip.id = `${prefix}-${index}`;
          clip.setAttribute("clipPathUnits", "userSpaceOnUse");
          const path = document.createElementNS(svgNamespace, "path");
          path.setAttribute("clip-rule", "evenodd");
          path.setAttribute("d", inverseRectPath(box.width, box.height, rect));
          if (index > 0) path.setAttribute("clip-path", `url(#${prefix}-${index - 1})`);
          clip.append(path);
          group.append(clip);
        }
        defs.append(group);
        state.definitions = group;
        element.style.clipPath = `url(#${prefix}-${box.rects.length - 1})`;
      }
      applied.set(element, state);
    }
  };

  const addCutout = (
    next: Map<HTMLElement, CutoutBox>,
    element: HTMLElement,
    overlays: HTMLElement[],
  ) => {
    const box = element.getBoundingClientRect();
    const rects = overlays
      .map((overlay) => cutoutRectWithin(overlay, box))
      .filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.x < box.width &&
          rect.y < box.height &&
          rect.x + rect.width > 0 &&
          rect.y + rect.height > 0,
      );
    if (rects.length === 0) return;
    const previous = next.get(element);
    next.set(element, {
      width: box.width,
      height: box.height,
      rects: [...(previous?.rects ?? []), ...rects],
    });
  };

  const collectPortaledCutouts = (next: Map<HTMLElement, CutoutBox>): number => {
    // Only the portal containers are searched: the root holds the whole transcript.
    const overlays: HTMLElement[] = [];
    for (const child of document.body.children) {
      if (child === root || child === svg) continue;
      if (child.matches(OVERLAY_SELECTOR)) overlays.push(child as HTMLElement);
      overlays.push(...child.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR));
    }
    const covering: HTMLElement[] = [];
    const onPage: HTMLElement[] = [];
    for (const overlay of overlays) {
      if (!isCoveringOverlay(overlay)) {
        // A kept-mounted overlay can reopen somewhere else; read its backing again then.
        backedOverlays.delete(overlay);
        overlay.removeAttribute(BACKED_OVERLAY_ATTRIBUTE);
        continue;
      }
      covering.push(overlay);
      let backed = backedOverlays.get(overlay);
      if (backed === undefined) {
        backed = isBackedByPortaledLayer(overlay, root);
        backedOverlays.set(overlay, backed);
      }
      if (overlay.hasAttribute(BACKED_OVERLAY_ATTRIBUTE) !== backed) {
        overlay.toggleAttribute(BACKED_OVERLAY_ATTRIBUTE, backed);
      }
      if (!backed) onPage.push(overlay);
    }
    addCutout(next, root, onPage);
    return covering.length;
  };

  const collectInPageCutouts = (next: Map<HTMLElement, CutoutBox>): number => {
    if (documentElement.dataset.windowTranslucency !== "window") return 0;
    let covering = 0;
    for (const wrapper of inPageOverlayWrappers) {
      const surface = wrapper.querySelector<HTMLElement>(IN_PAGE_SURFACE_SELECTOR);
      if (!surface || !wrapper.parentElement || !isCoveringOverlay(surface)) continue;
      covering += 1;
      for (const sibling of wrapper.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === wrapper) continue;
        // A closed Environment card can leave its preview rail visible. That chrome
        // still needs cutting out under the open panel, while open surfaces stay intact.
        if (inPageOverlayWrappers.has(sibling) && sibling.getAttribute("aria-hidden") !== "true")
          continue;
        addCutout(next, sibling, [surface]);
      }
    }
    return covering;
  };

  const tick = () => {
    frame = null;
    const next = new Map<HTMLElement, CutoutBox>();
    const covering =
      documentElement.dataset.windowMaterial === "translucent"
        ? collectPortaledCutouts(next) + collectInPageCutouts(next)
        : 0;
    applyClipPaths(next);
    idleFrames = covering > 0 ? 0 : idleFrames + 1;
    if (idleFrames > IDLE_FRAMES_BEFORE_STOP) return;
    // Overlays move while they animate in, follow their anchor, and resize with their content,
    // so the holes are re-read every frame for as long as one is showing.
    frame = requestAnimationFrame(tick);
  };

  const schedule = () => {
    idleFrames = 0;
    if (frame === null) frame = requestAnimationFrame(tick);
  };
  scheduleInstalledCutout = schedule;

  // Portaled overlays mount inside containers appended to the body, never inside the root, so
  // the root's own (very busy) subtree is not observed.
  const containerObserver = new MutationObserver(schedule);
  const observeContainers = () => {
    for (const child of document.body.children) {
      if (child === root || child === svg || observedContainers.has(child)) continue;
      observedContainers.add(child);
      // Attributes too: a kept-mounted overlay reopens by flipping its state attributes.
      containerObserver.observe(child, { attributes: true, childList: true, subtree: true });
    }
  };
  const bodyObserver = new MutationObserver(() => {
    observeContainers();
    schedule();
  });
  bodyObserver.observe(document.body, { childList: true });
  // The material and scope can change while an overlay is open (Appearance settings).
  const materialObserver = new MutationObserver(schedule);
  materialObserver.observe(documentElement, {
    attributes: true,
    attributeFilter: ["data-window-material", "data-window-translucency"],
  });
  observeContainers();
  schedule();

  return () => {
    bodyObserver.disconnect();
    containerObserver.disconnect();
    materialObserver.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    scheduleInstalledCutout = null;
    applyClipPaths(new Map());
    svg.remove();
  };
}
