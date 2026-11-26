// FILE: useCanvasCamera.ts
// Purpose: The canvas camera in use: zoom steps, 100%, fit and centre commands for every
//          control (keyboard, zoom menu, layers panel, comments), animated through the live
//          camera, interpolated per frame; and the viewport's own camera
//          wiring: the live transform, wheel pan and zoom (pinch told apart from a held
//          Ctrl), and first-open placement.
// Layer: Canvas editor camera
// Exports: useCanvasCameraCommands, useCanvasViewportCamera, selectionWorldRects,
//          animateCanvasCamera, CANVAS_WHEEL_SETTLE_MS, CANVAS_CAMERA_ANIMATION_MS

import type { DesignFrame, DesignViewport } from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { fitDesignCanvas, zoomDesignCanvas } from "~/lib/designCanvas";
import type { CanvasSelectionItem } from "../canvasStores";
import { useCanvasEditor, type CanvasEditorApi } from "./CanvasEditorContext";
import { elementBox, screenToWorldRect, type WorldRect } from "./canvasMeasure";

/** A wheel pan or zoom is committed once the wheel has been still this long. */
export const CANVAS_WHEEL_SETTLE_MS = 150;
/** How long a camera move from a command takes. */
export const CANVAS_CAMERA_ANIMATION_MS = 200;
/** Wheel zoom per pixel of delta: a pinch sends small deltas, a mouse wheel large ones. */
const PINCH_ZOOM_RATE = 0.01;
const WHEEL_ZOOM_RATE = 0.002;

const animations = new WeakMap<object, () => void>();

/**
 * Moves the camera to `target` over a short animation (interpolated per frame through
 * requestAnimationFrame), previewing each step without a render and saving the end with
 * `save`. A pan or zoom of the user's own during it stops it there; reduced motion jumps.
 */
export function animateCanvasCamera(
  camera: CanvasEditorApi["camera"],
  target: DesignViewport,
  save: (viewport: DesignViewport) => void,
) {
  animations.get(camera)?.();
  const from = camera.get();
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || (from.x === target.x && from.y === target.y && from.zoom === target.zoom))
    return save(target);
  const start = performance.now();
  let shown = from;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    animations.delete(camera);
  };
  const step = (now: number) => {
    // Someone else moved the camera: leave it where they put it.
    if (camera.get() !== shown) return stop();
    const progress = Math.min(1, (now - start) / CANVAS_CAMERA_ANIMATION_MS);
    const eased = 1 - (1 - progress) ** 3;
    if (progress >= 1) {
      stop();
      return save(target);
    }
    const zoom = from.zoom * (target.zoom / from.zoom) ** eased;
    camera.preview({
      zoom,
      x: from.x + (target.x - from.x) * eased,
      y: from.y + (target.y - from.y) * eased,
    });
    shown = camera.get();
    frame = requestAnimationFrame(step);
  };
  animations.set(camera, stop);
  frame = requestAnimationFrame(step);
}
/** Fitting never zooms past 200%. */
const FIT_MAX_ZOOM = 2;
/**
 * After the first fit on a page, a canvas that is still taking its size (a side pane opening, its
 * inspector appearing) is fitted again, until it has kept one size this long or the camera moved.
 */
export const CANVAS_FIRST_FIT_SETTLE_MS = 800;

const sameView = (a: DesignViewport, b: DesignViewport) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-6;

/** Where the selection is, in world pixels: frames from the model, layers as rendered. */
export function selectionWorldRects(
  editor: Pick<CanvasEditorApi, "elementFor" | "frame" | "camera">,
  items: readonly CanvasSelectionItem[],
  viewport: HTMLElement,
): WorldRect[] {
  const origin = viewport.getBoundingClientRect();
  return items.flatMap((item) => {
    if (item.kind === "frame") {
      const frame = editor.frame(item.frameId);
      return frame ? [{ x: frame.x, y: frame.y, width: frame.width, height: frame.height }] : [];
    }
    const element = editor.elementFor(item);
    const box = element ? elementBox(element, origin) : null;
    return box ? [screenToWorldRect(box, editor.camera.get())] : [];
  });
}

/**
 * Zoom and fit for any canvas control. `element` is the viewport the camera fills; the zoom
 * menu in a pane header finds it by query, the viewport passes its own.
 */
export function useCanvasCameraCommands(element: () => HTMLElement | null) {
  const editor = useCanvasEditor();
  const { camera, setViewport } = editor;
  const size = useCallback(() => {
    const viewport = element();
    return { width: viewport?.clientWidth ?? 800, height: viewport?.clientHeight ?? 600 };
  }, [element]);
  return useMemo(() => {
    const go = (target: DesignViewport) => animateCanvasCamera(camera, target, setViewport);
    const zoomBy = (factor: number) => {
      const { width, height } = size();
      go(zoomDesignCanvas(camera.get(), width / 2, height / 2, factor));
    };
    /** Fits `rects`, never past 200% (or `maxZoom`, when it is lower). */
    const fit = (
      rects: readonly Pick<DesignFrame, "x" | "y" | "width" | "height">[],
      options: { maxZoom?: number } = {},
    ) => {
      const { width, height } = size();
      const maxZoom = Math.min(FIT_MAX_ZOOM, options.maxZoom ?? FIT_MAX_ZOOM);
      go(fitDesignCanvas(rects, width, height, { maxZoom }));
    };
    return {
      /** Puts a world point in the middle of the canvas, at the zoom it has. */
      centre: (point: { x: number; y: number }) => {
        const { width, height } = size();
        const { zoom } = camera.get();
        go({ zoom, x: width / 2 - point.x * zoom, y: height / 2 - point.y * zoom });
      },
      zoomBy,
      /** To an absolute zoom around the centre (the zoom field). */
      zoomTo: (zoom: number) => zoomBy(zoom / camera.get().zoom),
      actualSize: () => zoomBy(1 / camera.get().zoom),
      fitAll: () => fit(editor.page.frames),
      /** ⇧2: the selected frames and layers, else everything. */
      fitSelection: () => {
        const viewport = element();
        const rects = viewport ? selectionWorldRects(editor, editor.selection, viewport) : [];
        fit(rects.length ? rects : editor.page.frames);
      },
      fit,
    };
  }, [camera, editor, element, setViewport, size]);
}

/**
 * The viewport's camera: writes the live camera to the world transform and to the
 * `--canvas-x/-y/-zoom` variables the overlay positions itself with, pans and zooms on the
 * wheel without a render (committed once the wheel settles), and places the camera on a page
 * this client has not opened before.
 */
export function useCanvasViewportCamera({
  root,
  world,
  pausedWheel,
}: {
  root: RefObject<HTMLElement | null>;
  world: RefObject<HTMLElement | null>;
  /** A pan gesture owns the camera; the wheel waits. */
  pausedWheel: () => boolean;
}) {
  const editor = useCanvasEditor();
  const { camera, cameraPlaced, setViewport } = editor;

  useLayoutEffect(() => {
    const apply = (view: DesignViewport) => {
      const element = root.current;
      const content = world.current;
      if (!element || !content) return;
      content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
      element.style.setProperty("--canvas-x", `${view.x}px`);
      element.style.setProperty("--canvas-y", `${view.y}px`);
      element.style.setProperty("--canvas-zoom", String(view.zoom));
    };
    apply(camera.get());
    return camera.subscribe(apply);
  }, [camera, root, world]);

  useEffect(() => {
    const element = root.current!;
    let settle: ReturnType<typeof setTimeout> | undefined;
    // A pinch arrives as ctrl+wheel without the Ctrl key being down; they are told apart.
    let ctrlDown = false;
    const keys = (event: KeyboardEvent) => {
      ctrlDown = event.ctrlKey;
    };
    const blur = () => {
      ctrlDown = false;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (pausedWheel()) return;
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const view = camera.get();
      const pinch = event.ctrlKey && !ctrlDown;
      // Pinch and Cmd/Ctrl+wheel zoom around the cursor; a mouse wheel's large steps slower.
      camera.preview(
        event.ctrlKey || event.metaKey
          ? zoomDesignCanvas(
              view,
              event.clientX - rect.left,
              event.clientY - rect.top,
              Math.exp(-event.deltaY * unit * (pinch ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE)),
            )
          : {
              ...view,
              x: view.x - (event.shiftKey ? event.deltaY : event.deltaX) * unit,
              y: view.y - (event.shiftKey ? 0 : event.deltaY) * unit,
            },
      );
      clearTimeout(settle);
      settle = setTimeout(camera.commit, CANVAS_WHEEL_SETTLE_MS);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keys, true);
    window.addEventListener("keyup", keys, true);
    window.addEventListener("blur", blur);
    return () => {
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keys, true);
      window.removeEventListener("keyup", keys, true);
      window.removeEventListener("blur", blur);
      clearTimeout(settle);
      camera.commit();
    };
  }, [camera, pausedWheel, root]);

  // A page this client has not placed yet: its frames are fitted on the first visit;
  // an empty page centres the origin at 100% and fits once its first frames arrive. It runs
  // before paint, so the default camera never flashes.
  const savedFrames = editor.page.frames;
  /** The first fit while the canvas may still be taking its size (see the settle effect). */
  const settling = useRef<{
    fitted: DesignViewport;
    width: number;
    height: number;
    until: number;
  } | null>(null);
  const framesRef = useRef(savedFrames);
  framesRef.current = savedFrames;
  useLayoutEffect(() => {
    if (cameraPlaced) return;
    const element = root.current;
    if (!element) return;
    const place = () => {
      // A pane that is still opening has no size yet; place the camera once it has one.
      if (element.clientWidth < 40 || element.clientHeight < 40) return false;
      if (savedFrames.length > 0) {
        const fitted = fitDesignCanvas(savedFrames, element.clientWidth, element.clientHeight, {
          maxZoom: FIT_MAX_ZOOM,
        });
        settling.current = {
          fitted,
          width: element.clientWidth,
          height: element.clientHeight,
          until: performance.now() + CANVAS_FIRST_FIT_SETTLE_MS,
        };
        setViewport(fitted);
      } else
        setViewport(
          { x: element.clientWidth / 2, y: element.clientHeight / 2, zoom: 1 },
          { automatic: true },
        );
      return true;
    };
    if (place()) return;
    const observer = new ResizeObserver(() => {
      if (place()) observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [cameraPlaced, root, savedFrames, setViewport]);

  // The first fit can land while the canvas is still taking its size: a side pane that is
  // opening, or whose inspector appears once the pane is measured. Until the canvas has kept one
  // size for a moment, and unless the camera was moved meanwhile, each new size fits again.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const state = settling.current;
      if (!state) return;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width === state.width && height === state.height) return;
      if (performance.now() > state.until || !sameView(camera.get(), state.fitted)) {
        settling.current = null;
        return;
      }
      if (width < 40 || height < 40 || framesRef.current.length === 0) return;
      const fitted = fitDesignCanvas(framesRef.current, width, height, { maxZoom: FIT_MAX_ZOOM });
      settling.current = {
        fitted,
        width,
        height,
        until: performance.now() + CANVAS_FIRST_FIT_SETTLE_MS,
      };
      setViewport(fitted);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [camera, root, setViewport]);
}
