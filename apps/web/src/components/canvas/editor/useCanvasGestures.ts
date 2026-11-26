// FILE: useCanvasGestures.ts
// Purpose: The canvas's pointer gestures: pan, click and drag to select and move, resize
//          handles, flex spacing handles, marquee, drawing frames, shapes and text, comments and
//          double-click. A gesture lives in a ref and writes its preview straight to the DOM
//          (camera, frame wrappers, layer styles, the overlay, the gesture layer, the live
//          geometry the inspector reads): the canvas renders when a gesture starts and when it
//          settles, never while the pointer moves.
// Layer: Canvas editor input
// Exports: useCanvasGestures, CanvasFrameDrafts, CanvasPendingComment

import type { CanvasFrameLayoutPatch, DesignFrame, DesignViewport } from "@synara/contracts";
import {
  DESIGN_FRAME_MAX_HEIGHT,
  DESIGN_FRAME_MAX_WIDTH,
  DESIGN_FRAME_MIN_SIZE,
} from "@synara/contracts";
import type { DesignLayerEdit } from "@synara/contracts";
import { DESIGN_LAYER_ATTRIBUTE } from "@synara/shared/designCanvasLayers";
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { screenToWorld } from "~/lib/designCanvas";
import {
  selectionKey,
  useCanvasEditorStore,
  type CanvasSelectionItem,
  type CanvasTool,
} from "../canvasStores";
import { canvasId, restyledLayerHtml } from "./canvasClipboard";
import { useCanvasEditor, type CanvasEditorApi } from "./CanvasEditorContext";
import type { CanvasGestureLayer, FlowDrop } from "./canvasGestureLayer";
import {
  CANVAS_DRAGGING_ATTRIBUTE,
  canvasGestureHidesChrome,
  constrainToAxis,
  DRAG_THRESHOLD,
  dragPosition,
  isSameFlowPlace,
  offsetInParent,
  resizeGeometry,
  resolveFlowDrop,
  resolveParentDrop,
  rotateDelta,
  spacingValue,
  type ParentDrop,
  type ResizeHandle,
  type ResizeResult,
  type SpacingHandle,
} from "./canvasGestures";
import { placementOf } from "./canvasHistory";
import { canvasLiveGeometry, type LiveGeometry } from "./canvasLiveGeometry";
import {
  CANVAS_CLICK_DRAW_SIZE,
  drawnRect,
  elementBox,
  isFreePositioned,
  layoutSize,
  positionedOffset,
  rectFromPoints,
  screenToWorldRect,
  type Point,
  type ScreenRect,
  type WorldRect,
} from "./canvasMeasure";
import { CANVAS_GESTURE_ATTRIBUTE, layerAngle, type CanvasOverlayHandle } from "./CanvasOverlay";
import {
  frameAtPoint,
  HIT_TOLERANCE,
  isDoubleClick,
  isLayerLocked,
  isTextOnly,
  layerChain,
  MARQUEE_THRESHOLD,
  marqueeSelection,
  orderHitStack,
  resolveClickSelection,
  resolveDrillSelection,
  toggleSelection,
  unlockedHitLayer,
  type LayerItem,
} from "./canvasSelection";
import type { CanvasTextEditing } from "./useCanvasTextEditing";

/** Frame positions and sizes shown before the save that set them has come back. */
export type CanvasFrameDrafts = Readonly<Record<string, Partial<DesignFrame>>>;
export type CanvasPendingComment = {
  frameId: string;
  layerId: string | null;
  x: number;
  y: number;
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const TEXT_STYLE = "margin:0;font-size:16px;line-height:1.4;color:#111111";
/** At most this many layers are checked against the hit tolerance per hit test. */
const NEAR_SCAN_LIMIT = 1500;

type Moving = { origin: Point; wrapper: HTMLElement | null };
type Modifiers = { shift: boolean; alt: boolean };
type Last = { point: Point; client: Point; modifiers: Modifiers };
type Gesture =
  | { type: "pan"; pointer: number; x: number; y: number; view: DesignViewport }
  | {
      type: "press";
      pointer: number;
      x: number;
      y: number;
      /** The pointer in world pixels when it went down: drags follow world positions. */
      world: Point;
      last: Last | null;
      pressed: CanvasSelectionItem;
      /** A press on one item of a multi-selection selects only it, unless it drags. */
      collapse: boolean;
      items: readonly CanvasSelectionItem[];
      dragging: boolean;
      /** Frames and freely placed layers that move, by selection key. */
      moving: Map<string, Moving & { item: CanvasSelectionItem }>;
      /** Overlay boxes that follow the drag: what moves, and selected layers inside a moving frame. */
      boxes: Set<string>;
      /** Cmd/Ctrl press: a drag becomes a marquee that reaches into containers. */
      deep: boolean;
      /** One flow (non-absolute) layer: dragging reorders it inside its layout. */
      flow: LayerItem | null;
      drop: FlowDrop | null;
      /** One free layer dragged over another container moves into it on release. */
      reparent: ParentDrop | null;
    }
  | {
      type: "resize";
      pointer: number;
      x: number;
      y: number;
      world: Point;
      last: Last | null;
      item: CanvasSelectionItem;
      handle: ResizeHandle;
      /** Frames: x/y/size; layers: left/top and offset size. */
      origin: WorldRect;
      /** The layer's world box as the overlay measured it, which a preview is relative to. */
      measured: WorldRect | null;
      /** The layer's rotation in degrees: its handles resize along its own axes. */
      angle: number;
      free: boolean;
      wrapper: HTMLElement | null;
      result: ResizeResult | null;
    }
  | {
      type: "spacing";
      pointer: number;
      x: number;
      y: number;
      world: Point;
      item: LayerItem;
      handle: SpacingHandle;
      /** The CSS property written: a padding side, or the gap along the main axis. */
      property: string;
      origin: number;
      row: boolean;
      value: number;
    }
  | {
      type: "marquee";
      pointer: number;
      x: number;
      y: number;
      deep: boolean;
      /** Shift: the selection held before the marquee, which it toggles against. */
      prior: readonly CanvasSelectionItem[] | null;
      /** The selection before the gesture, so the net change is one undo step. */
      before: readonly CanvasSelectionItem[];
      /** The last pointer position: holding Space moves the marquee with it. */
      last: Point;
    }
  | {
      type: "draw";
      pointer: number;
      x: number;
      y: number;
      tool: "frame" | "rectangle" | "text";
      /** The last pointer position: holding Space moves the box's origin with it. */
      last: Point;
      modifiers: { shift: boolean; alt: boolean };
    }
  | { type: "comment"; pointer: number; x: number; y: number; pending: CanvasPendingComment };

/** The element that positions a frame on the world (its label and shadow host live in it). */
function frameWrapper(editor: Pick<CanvasEditorApi, "elementFor">, frameId: string) {
  const root = editor.elementFor({ kind: "frame", frameId });
  const owner = root?.getRootNode();
  return owner instanceof ShadowRoot ? (owner.host.parentElement as HTMLElement | null) : null;
}

const place = (element: HTMLElement | null, rect: Partial<WorldRect>) => {
  if (!element) return;
  if (rect.x !== undefined) element.style.left = `${rect.x}px`;
  if (rect.y !== undefined) element.style.top = `${rect.y}px`;
  if (rect.width !== undefined) element.style.width = `${rect.width}px`;
  if (rect.height !== undefined) element.style.height = `${rect.height}px`;
};

const clampFrameSize = (result: WorldRect) => ({
  x: Math.round(result.x),
  y: Math.round(result.y),
  width: Math.round(
    Math.max(DESIGN_FRAME_MIN_SIZE, Math.min(DESIGN_FRAME_MAX_WIDTH, result.width)),
  ),
  height: Math.round(
    Math.max(DESIGN_FRAME_MIN_SIZE, Math.min(DESIGN_FRAME_MAX_HEIGHT, result.height)),
  ),
});

/** Runs `task` once per animation frame with the latest arguments it was scheduled with. */
function frameThrottle<A extends unknown[]>(task: (...args: A) => void) {
  let pending: A | null = null;
  let id = 0;
  return {
    schedule: (...args: A) => {
      pending = args;
      if (id) return;
      id = requestAnimationFrame(() => {
        id = 0;
        const next = pending;
        pending = null;
        if (next) task(...next);
      });
    },
    cancel: () => {
      cancelAnimationFrame(id);
      id = 0;
      pending = null;
    },
  };
}

/** The style a layer resize writes: only the axes and edges it moved. */
const resizePatch = (current: Extract<Gesture, { type: "resize" }>, result: ResizeResult) => ({
  ...(result.changed.width ? { width: `${Math.round(result.width)}px` } : {}),
  ...(result.changed.height ? { height: `${Math.round(result.height)}px` } : {}),
  ...(current.free && result.x !== current.origin.x ? { left: `${Math.round(result.x)}px` } : {}),
  ...(current.free && result.y !== current.origin.y ? { top: `${Math.round(result.y)}px` } : {}),
});

/** Whether a layer can be edited as text in place (and is not locked). */
const editableText = (editor: CanvasEditorApi, item: LayerItem) => {
  const index = editor.layers(item.frameId);
  return (
    index !== undefined && !isLayerLocked(index, item.layerId) && isTextOnly(index, item.layerId)
  );
};

export function useCanvasGestures(input: {
  root: RefObject<HTMLDivElement | null>;
  gestureLayer: RefObject<CanvasGestureLayer | null>;
  overlay: RefObject<CanvasOverlayHandle | null>;
  /** The page's frames as shown (drafts applied). */
  frames: readonly DesignFrame[];
  tool: CanvasTool;
  panning: boolean;
  /** Space is held: a marquee in progress moves with the pointer. */
  spaceHeld: () => boolean;
  setDrafts: Dispatch<SetStateAction<CanvasFrameDrafts>>;
  setHover: Dispatch<SetStateAction<CanvasSelectionItem | null>>;
  text: CanvasTextEditing;
  /** A comment pin placed with the Comment tool; null when a press only closed an open thread. */
  onComment: (pending: CanvasPendingComment) => void;
  onRenameFrame: (frameId: string) => void;
  /**
   * A resize handle was double-clicked: its axes fit the content (fill the parent with Alt).
   * `axes` are the handle's: a corner both, an edge one.
   */
  onHandleDoubleClick?: (axes: readonly ("width" | "height")[], fill: boolean) => void;
  /** The placeholder of a new text layer. */
  newText: string;
  /** The marquee's "N selected" chip. */
  countLabel: (count: number) => string;
}) {
  const { root, gestureLayer, overlay, frames, tool, panning, setDrafts, setHover, text } = input;
  const editor = useCanvasEditor();
  const { readOnly, select, selection, camera, commands } = editor;
  const setTool = useCanvasEditorStore((state) => state.setTool);
  const gesture = useRef<Gesture | null>(null);
  // The double-click: the press before this one, while it can still be the first click.
  const lastClick = useRef<{ time: number; x: number; y: number } | null>(null);
  /** The last press on a resize handle, for its double-click. */
  const lastHandlePress = useRef<{ time: number; x: number; y: number; handle: string } | null>(
    null,
  );
  const frameById = new Map(frames.map((frame) => [frame.id, frame]));

  // Work that reads layout runs at most once per frame, with the newest pointer position.
  const throttled = useRef<{
    hover: ReturnType<typeof frameThrottle<[Point, string | null, boolean]>>;
    marquee: ReturnType<typeof frameThrottle<[ScreenRect, boolean, Point]>>;
    drop: ReturnType<typeof frameThrottle<[LayerItem, number, number]>>;
    parent: ReturnType<typeof frameThrottle<[LayerItem, number, number, Point]>>;
    resize: ReturnType<typeof frameThrottle<[]>>;
  } | null>(null);
  const latest = useRef({
    editor,
    frames,
    countLabel: input.countLabel,
    resolveHit: null as unknown as typeof resolveHit,
  });

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = root.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  /**
   * Marks the gesture on the viewport. `handle` is the resize or spacing handle it started on:
   * its cursor stays on the canvas until release, since the canvas holds the pointer and the
   * pointer soon leaves the handle (set outside React, so nothing re-renders).
   */
  const setGestureAttribute = (value: string | null, handle?: HTMLElement) => {
    const element = root.current;
    if (value) element?.setAttribute(CANVAS_GESTURE_ATTRIBUTE, value);
    else {
      element?.removeAttribute(CANVAS_GESTURE_ATTRIBUTE);
      element?.removeAttribute(CANVAS_DRAGGING_ATTRIBUTE);
    }
    if (element) element.style.cursor = handle ? getComputedStyle(handle).cursor : "";
  };
  /** Marks the viewport once the gesture really drags (canvasGestureHidesChrome). */
  const markDragging = (event: { clientX: number; clientY: number; pointerId: number }) => {
    const element = root.current;
    const current = gesture.current;
    if (!element || !current || current.pointer !== event.pointerId) return;
    if (element.hasAttribute(CANVAS_DRAGGING_ATTRIBUTE)) return;
    const point = localPoint(event);
    const distance = Math.hypot(point.x - current.x, point.y - current.y);
    if (canvasGestureHidesChrome(current, distance))
      element.setAttribute(CANVAS_DRAGGING_ATTRIBUTE, "");
  };
  const frameScreenRect = (frame: Pick<DesignFrame, "x" | "y" | "width" | "height">) => {
    const view = camera.get();
    return {
      x: view.x + frame.x * view.zoom,
      y: view.y + frame.y * view.zoom,
      width: frame.width * view.zoom,
      height: frame.height * view.zoom,
    };
  };
  /** The pointer's world position: a drag follows it, so a wheel pan or zoom keeps it in step. */
  const worldAt = (point: Point) => screenToWorld(camera.get(), point.x, point.y);

  /**
   * The hit test at a client point in one frame: every layer within the tolerance, deepest
   * last (`orderHitStack`), and the layer a click acts on.
   */
  const stackAt = (frameId: string, clientX: number, clientY: number) => {
    const current = latest.current.editor;
    const frameRoot = current.elementFor({ kind: "frame", frameId });
    const index = current.layers(frameId);
    const frame = current.frame(frameId);
    const shadow = frameRoot?.getRootNode();
    if (!frameRoot || !index || !frame || !(shadow instanceof ShadowRoot)) return null;
    const exact = shadow.elementsFromPoint(clientX, clientY).flatMap((element) => {
      if (element === frameRoot || !frameRoot.contains(element)) return [];
      const id = element.getAttribute(DESIGN_LAYER_ATTRIBUTE);
      return id ? [id] : [];
    });
    // Layers within the tolerance, inside the topmost one under the pointer (or the frame).
    const scope = exact[0]
      ? current.elementFor({ kind: "layer", frameId, layerId: exact[0] })
      : frameRoot;
    const near: string[] = [];
    let checked = 0;
    for (const element of scope?.querySelectorAll<HTMLElement>(`[${DESIGN_LAYER_ATTRIBUTE}]`) ??
      []) {
      if (++checked > NEAR_SCAN_LIMIT) break;
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (
        clientX >= box.left - HIT_TOLERANCE &&
        clientX <= box.right + HIT_TOLERANCE &&
        clientY >= box.top - HIT_TOLERANCE &&
        clientY <= box.bottom + HIT_TOLERANCE
      )
        near.push(element.getAttribute(DESIGN_LAYER_ATTRIBUTE)!);
    }
    return orderHitStack(index, frame.layers.roots, exact, near);
  };

  /** What a press at a client point would select, and the layers under it. */
  const resolveHit = (clientX: number, clientY: number, deep: boolean) => {
    const current = latest.current;
    const element = root.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const located = frameAtPoint(
      current.frames,
      screenToWorld(camera.get(), clientX - box.left, clientY - box.top),
    );
    // A locked frame and everything in it is out of reach.
    if (!located || located.frame.locked) return null;
    const frame = located.frame;
    const index = current.editor.layers(frame.id);
    if (!index) return null;
    const stack = stackAt(frame.id, clientX, clientY);
    const target = stack?.target ? unlockedHitLayer(index, stack.target) : null;
    const item = resolveClickSelection({
      frame,
      index,
      hitLayerId: target,
      selection: current.editor.selection,
      deep,
      measure: (layerId) => {
        const node = current.editor.elementFor({ kind: "layer", frameId: frame.id, layerId });
        return node ? layoutSize(node) : null;
      },
      depthOf: (item) => {
        const other = current.editor.layers(item.frameId);
        return other ? layerChain(other, item.layerId).length - 1 : 0;
      },
    });
    return {
      frameId: frame.id,
      stack: stack?.stack ?? [],
      target,
      raw: stack?.target ?? null,
      item,
    };
  };
  latest.current = { editor, frames, countLabel: input.countLabel, resolveHit };

  /** A layer's box as far as it is visible: clipped by clipping ancestors and its frame. */
  const visibleLayerRect = (
    origin: DOMRect,
    clips: Map<Element, boolean>,
    frameId: string,
    layerId: string,
  ): ScreenRect | null => {
    const current = latest.current;
    const node = current.editor.elementFor({ kind: "layer", frameId, layerId });
    const frameRoot = current.editor.elementFor({ kind: "frame", frameId });
    const frame = current.frames.find((item) => item.id === frameId);
    const box = node ? elementBox(node, origin) : null;
    if (!box || !frameRoot || !frame) return null;
    let rect: ScreenRect = box;
    const clip = (outer: ScreenRect) => {
      const x = Math.max(rect.x, outer.x);
      const y = Math.max(rect.y, outer.y);
      const right = Math.min(rect.x + rect.width, outer.x + outer.width);
      const bottom = Math.min(rect.y + rect.height, outer.y + outer.height);
      rect = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    };
    for (
      let parent = node!.parentElement;
      parent && parent !== frameRoot;
      parent = parent.parentElement
    ) {
      let clipping = clips.get(parent);
      if (clipping === undefined) {
        const style = getComputedStyle(parent);
        clipping = style.overflowX !== "visible" || style.overflowY !== "visible";
        clips.set(parent, clipping);
      }
      if (clipping) {
        const outer = elementBox(parent, origin);
        if (outer) clip(outer);
      }
    }
    clip(frameScreenRect(frame));
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };

  const marqueeItems = (rect: ScreenRect, deep: boolean) => {
    const { editor: current, frames: shown } = latest.current;
    const origin = root.current!.getBoundingClientRect();
    const byId = new Map(shown.map((frame) => [frame.id, frame]));
    const clips = new Map<Element, boolean>();
    return marqueeSelection({
      frames: shown.filter((frame) => !frame.locked),
      rect,
      deep,
      frameRect: (frameId) => {
        const frame = byId.get(frameId);
        return frame ? frameScreenRect(frame) : null;
      },
      layerRect: (frameId, layerId) => visibleLayerRect(origin, clips, frameId, layerId),
      index: (frameId) => current.layers(frameId),
    });
  };

  throttled.current ??= {
    hover: frameThrottle((client, label, deep) => {
      const next = label
        ? ({ kind: "frame", frameId: label } as const)
        : (latest.current.resolveHit(client.x, client.y, deep)?.item ?? null);
      setHover((previous) =>
        previous && next && selectionKey(previous) === selectionKey(next) ? previous : next,
      );
    }),
    marquee: frameThrottle((rect, deep, pointer) => {
      const moved = Math.hypot(rect.width, rect.height) >= MARQUEE_THRESHOLD;
      const items = moved ? marqueeItems(rect, deep) : [];
      const origin = root.current!.getBoundingClientRect();
      const clips = new Map<Element, boolean>();
      const boxes = items.flatMap((item) => {
        if (item.kind === "layer") {
          const box = visibleLayerRect(origin, clips, item.frameId, item.layerId);
          return box ? [box] : [];
        }
        const frame = latest.current.frames.find((candidate) => candidate.id === item.frameId);
        return frame ? [frameScreenRect(frame)] : [];
      });
      gestureLayer.current?.marquee(
        moved ? rect : null,
        boxes,
        {
          leading: deep ? (isMac ? "⌘" : "Ctrl") : undefined,
          label: latest.current.countLabel(boxes.length),
        },
        pointer,
      );
    }),
    drop: frameThrottle((item, clientX, clientY) => {
      const current = gesture.current;
      if (current?.type !== "press" || !current.dragging) return;
      current.drop = resolveFlowDrop(latest.current.editor, root.current!, item, clientX, clientY);
      gestureLayer.current?.drop(current.drop);
    }),
    parent: frameThrottle((item, clientX, clientY, pointer) => {
      const current = gesture.current;
      if (current?.type !== "press" || !current.dragging) return;
      current.reparent = resolveParentDrop(
        latest.current.editor,
        root.current!,
        item,
        clientX,
        clientY,
      );
      gestureLayer.current?.container(
        current.reparent?.container ?? null,
        current.reparent?.label,
        pointer,
      );
    }),
    resize: frameThrottle(() => {
      const current = gesture.current;
      if (current?.type !== "resize" || !current.measured) return;
      const element = latest.current.editor.elementFor(current.item);
      const box = element ? elementBox(element, root.current!.getBoundingClientRect()) : null;
      if (!box) return;
      const now = screenToWorldRect(box, camera.get());
      overlay.current?.preview({
        keys: new Set([selectionKey(current.item)]),
        dx: now.x - current.measured.x,
        dy: now.y - current.measured.y,
        dw: now.width - current.measured.width,
        dh: now.height - current.measured.height,
      });
    }),
  };
  const capture = (pointerId: number) => root.current?.setPointerCapture(pointerId);
  const release = (pointerId: number) => {
    if (root.current?.hasPointerCapture(pointerId)) root.current.releasePointerCapture(pointerId);
  };

  /** Puts everything a gesture previewed back as it was saved. */
  const revert = (current: Gesture) => {
    const timers = throttled.current!;
    timers.marquee.cancel();
    timers.drop.cancel();
    timers.parent.cancel();
    timers.resize.cancel();
    gestureLayer.current?.clear();
    canvasLiveGeometry.clear();
    if (current.type === "pan") camera.revert();
    if (current.type === "press") {
      if (current.flow) {
        const dragged = editor.elementFor(current.flow);
        if (dragged) dragged.style.opacity = "";
      }
      for (const { item, origin, wrapper } of current.moving.values()) {
        if (item.kind === "frame") place(wrapper, origin);
        else editor.discardPreview([item]);
      }
    }
    if (current.type === "resize") {
      if (current.item.kind === "frame") place(current.wrapper, current.origin);
      else editor.discardPreview([current.item]);
    }
    if (current.type === "spacing") editor.discardPreview([current.item]);
    if (current.type === "marquee") select(current.before, { record: false });
    overlay.current?.settle();
  };

  /** Ends the gesture in progress without applying it (Esc). */
  const cancel = () => {
    const current = gesture.current;
    if (!current) return false;
    gesture.current = null;
    release(current.pointer);
    setGestureAttribute(null);
    revert(current);
    return true;
  };

  /** A gesture is torn down when the window loses focus: a pan keeps where it got to. */
  useEffect(() => {
    const blur = () => {
      const current = gesture.current;
      if (!current) return;
      if (current.type !== "pan") return void cancel();
      gesture.current = null;
      release(current.pointer);
      setGestureAttribute(null);
      camera.commit();
    };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  });

  // Nothing scheduled outlives the canvas.
  useEffect(
    () => () => {
      const timers = throttled.current;
      timers?.hover.cancel();
      timers?.marquee.cancel();
      timers?.drop.cancel();
      timers?.parent.cancel();
      timers?.resize.cancel();
    },
    [],
  );

  /** A double-click: rename, edit text, or drill in. */
  const doubleClick = (event: React.PointerEvent<HTMLDivElement>, label: string | null) => {
    if (readOnly) return false;
    if (label) {
      input.onRenameFrame(label);
      return true;
    }
    const hit = resolveHit(event.clientX, event.clientY, false);
    if (!hit) return false;
    const index = editor.layers(hit.frameId);
    if (!index) return false;
    // Editable text under the pointer starts editing however deep it sits.
    if (hit.target) {
      const deepest: LayerItem = { kind: "layer", frameId: hit.frameId, layerId: hit.target };
      if (hit.target === hit.raw && editableText(editor, deepest) && text.start(deepest))
        return true;
    }
    // Drill from the selected layer the pointer is in (the deepest one), else from the frame.
    const chain = hit.target ? layerChain(index, hit.target) : [];
    const current = selection
      .filter(
        (item): item is LayerItem =>
          item.kind === "layer" && item.frameId === hit.frameId && chain.includes(item.layerId),
      )
      .toSorted((a, b) => chain.indexOf(b.layerId) - chain.indexOf(a.layerId))[0];
    const next = resolveDrillSelection({
      frameId: hit.frameId,
      index,
      hitLayerId: hit.target,
      current,
    });
    if (!next || (current && selectionKey(next) === selectionKey(current))) return false;
    // Shift keeps the rest of the selection: the drilled layer takes its parent's place.
    select(
      event.shiftKey
        ? [
            ...selection.filter((item) => !current || selectionKey(item) !== selectionKey(current)),
            next,
          ]
        : [next],
    );
    return true;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = root.current!;
    if (event.button === 2) return;
    const target = event.target as HTMLElement;
    // A press in a popup the canvas's own controls opened (the zoom menu) reaches here through
    // React's portal bubbling; it belongs to that popup, not to the canvas.
    if (!element.contains(target)) return;
    const handle = target.closest<HTMLElement>("[data-canvas-handle],[data-canvas-spacing]");
    if (!handle && target.closest("[data-canvas-ui]")) return;
    const path = event.nativeEvent.composedPath();
    if (editor.editingText) {
      if (text.owns(path)) return;
      void text.commit();
    }
    element.focus({ preventScroll: true });
    const point = localPoint(event);
    const start = { pointer: event.pointerId, x: point.x, y: point.y };
    if (event.button === 1 || panning) {
      event.preventDefault();
      capture(event.pointerId);
      gesture.current = { type: "pan", ...start, view: camera.get() };
      setGestureAttribute("pan");
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    if (handle && !readOnly) {
      const item = selection.find((entry) => selectionKey(entry) === handle.dataset.canvasItem);
      if (handle.dataset.canvasSpacing && item?.kind === "layer") {
        const node = editor.elementFor(item);
        if (node) {
          const spacing = handle.dataset.canvasSpacing as SpacingHandle;
          const style = getComputedStyle(node);
          const row = style.flexDirection.startsWith("row");
          const property = spacing === "gap" ? (row ? "column-gap" : "row-gap") : spacing;
          const origin = Number.parseFloat(style.getPropertyValue(property)) || 0;
          capture(event.pointerId);
          gesture.current = {
            type: "spacing",
            ...start,
            world: worldAt(point),
            item,
            handle: spacing,
            property,
            origin,
            row,
            value: origin,
          };
          setGestureAttribute("spacing", handle);
          return;
        }
      }
      const frame = item ? frameById.get(item.frameId) : undefined;
      const node = item?.kind === "layer" ? editor.elementFor(item) : null;
      const origin: WorldRect | null =
        item?.kind === "frame" && frame
          ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
          : node
            ? { ...positionedOffset(node), ...layoutSize(node) }
            : null;
      if (item && origin && handle.dataset.canvasHandle) {
        const side = handle.dataset.canvasHandle;
        const click = { time: event.timeStamp, x: event.clientX, y: event.clientY, handle: side };
        const previous = lastHandlePress.current;
        if (
          input.onHandleDoubleClick &&
          previous?.handle === side &&
          isDoubleClick(previous, click)
        ) {
          lastHandlePress.current = null;
          // n / s size the height, e / w the width, a corner both.
          const axes = [
            ...(/[ew]/.test(side) ? (["width"] as const) : []),
            ...(/[ns]/.test(side) ? (["height"] as const) : []),
          ];
          input.onHandleDoubleClick(axes, event.altKey);
          return;
        }
        lastHandlePress.current = click;
        const box = node ? elementBox(node, element.getBoundingClientRect()) : null;
        capture(event.pointerId);
        gesture.current = {
          type: "resize",
          ...start,
          world: worldAt(point),
          last: null,
          item,
          handle: handle.dataset.canvasHandle as ResizeHandle,
          origin,
          measured: box ? screenToWorldRect(box, camera.get()) : null,
          angle: node ? layerAngle(node) : 0,
          free: node ? isFreePositioned(node) : false,
          wrapper: item.kind === "frame" ? frameWrapper(editor, item.frameId) : null,
          result: null,
        };
        setGestureAttribute("resize", handle);
        return;
      }
    }
    const labelled =
      target.closest<HTMLElement>("[data-canvas-frame-label]")?.dataset.canvasFrameLabel ?? null;
    const label = labelled && !frameById.get(labelled)?.locked ? labelled : null;
    const additive = event.shiftKey;
    const deep = isMac ? event.metaKey : event.ctrlKey;
    if (tool === "text" && !readOnly) {
      // The Text tool puts a caret where it clicks in existing text.
      const hit = resolveHit(event.clientX, event.clientY, true);
      if (hit?.target && hit.target === hit.raw) {
        const item: LayerItem = { kind: "layer", frameId: hit.frameId, layerId: hit.target };
        if (
          editableText(editor, item) &&
          text.start(item, { caret: { x: event.clientX, y: event.clientY } })
        ) {
          setTool("move");
          return;
        }
      }
    }
    if (tool === "frame" || tool === "rectangle" || tool === "text") {
      if (readOnly) return;
      capture(event.pointerId);
      gesture.current = {
        type: "draw",
        ...start,
        tool,
        last: point,
        modifiers: { shift: event.shiftKey, alt: event.altKey },
      };
      setGestureAttribute("draw");
      return;
    }
    if (tool === "comment") {
      // With a thread open, the first click only closes it.
      if (editor.activeCommentId) {
        editor.openComment(null);
        return;
      }
      const world = worldAt(point);
      const located = frameAtPoint(frames, world);
      if (!located) return;
      // Locked layers are comment targets too while the tool is active.
      const layerId = stackAt(located.frame.id, event.clientX, event.clientY)?.target ?? null;
      const layerElement = layerId
        ? editor.elementFor({ kind: "layer", frameId: located.frame.id, layerId })
        : null;
      const layerBox = layerElement
        ? elementBox(layerElement, element.getBoundingClientRect())
        : null;
      const layerWorld = layerBox ? screenToWorldRect(layerBox, camera.get()) : null;
      capture(event.pointerId);
      // The composer opens on pointer up.
      gesture.current = {
        type: "comment",
        ...start,
        pending: {
          frameId: located.frame.id,
          layerId,
          x: layerWorld ? world.x - layerWorld.x : located.x,
          y: layerWorld ? world.y - layerWorld.y : located.y,
        },
      };
      return;
    }
    if (tool === "move") {
      const click = { time: event.timeStamp, x: event.clientX, y: event.clientY };
      if (isDoubleClick(lastClick.current, click)) {
        lastClick.current = null;
        if (doubleClick(event, label)) return;
      } else lastClick.current = click;
    }
    const pressed: CanvasSelectionItem | null = label
      ? { kind: "frame", frameId: label }
      : (resolveHit(event.clientX, event.clientY, deep)?.item ?? null);
    if (!pressed) {
      // The net change of the marquee is one undo step.
      const before = selection;
      if (!additive) select([], { record: false });
      capture(event.pointerId);
      gesture.current = {
        type: "marquee",
        ...start,
        deep: false,
        prior: additive ? selection : null,
        before,
        last: point,
      };
      setGestureAttribute("marquee");
      return;
    }
    const key = selectionKey(pressed);
    const already = selection.some((item) => selectionKey(item) === key);
    let next = selection;
    if (additive)
      next = already
        ? selection.filter((item) => selectionKey(item) !== key)
        : [...selection, pressed];
    else if (!already) next = [pressed];
    // A Cmd/Ctrl press selects on release: dragging it draws a marquee instead.
    if (!deep) select(next);
    // A selected frame carries its layers: they move with it, not on their own as well.
    const movingFrames = new Set(
      next.filter((item) => item.kind === "frame").map((item) => item.frameId),
    );
    const moving = new Map<string, Moving & { item: CanvasSelectionItem }>();
    let flow: LayerItem | null = null;
    for (const item of next) {
      if (item.kind === "frame") {
        const frame = frameById.get(item.frameId);
        if (frame)
          moving.set(selectionKey(item), {
            item,
            origin: { x: frame.x, y: frame.y },
            wrapper: frameWrapper(editor, item.frameId),
          });
        continue;
      }
      if (
        movingFrames.has(item.frameId) ||
        isLayerLocked(editor.layers(item.frameId), item.layerId)
      )
        continue;
      const node = editor.elementFor(item);
      if (node && isFreePositioned(node))
        moving.set(selectionKey(item), { item, origin: positionedOffset(node), wrapper: null });
      else if (next.length === 1 && node) flow = item;
    }
    const boxes = new Set(moving.keys());
    for (const item of next) if (movingFrames.has(item.frameId)) boxes.add(selectionKey(item));
    capture(event.pointerId);
    gesture.current = {
      type: "press",
      ...start,
      world: worldAt(point),
      last: null,
      pressed,
      collapse: !additive && already && selection.length > 1,
      items: next,
      dragging: false,
      moving,
      boxes,
      deep,
      flow,
      drop: null,
      reparent: null,
    };
    setGestureAttribute("press");
  };

  /** A world delta since the press, kept to one axis with Shift. */
  const worldDelta = (from: Point, point: Point, shift: boolean) => {
    const now = worldAt(point);
    const delta = { x: now.x - from.x, y: now.y - from.y };
    return shift ? constrainToAxis(delta) : delta;
  };

  /** A press's drag at a pointer position: also re-run when the camera moves under it. */
  const movePress = (current: Extract<Gesture, { type: "press" }>, last: Last) => {
    current.last = last;
    if (current.flow) {
      throttled.current!.drop.schedule(current.flow, last.client.x, last.client.y);
      return;
    }
    const delta = worldDelta(current.world, last.point, last.modifiers.shift);
    const live: [string, LiveGeometry][] = [];
    for (const [key, { item, origin, wrapper }] of current.moving) {
      const at = dragPosition(origin, delta, 1);
      live.push([key, at]);
      if (item.kind === "frame") place(wrapper, at);
      else editor.previewStyles([item], { left: `${at.x}px`, top: `${at.y}px` }, { quiet: true });
    }
    canvasLiveGeometry.set(live);
    const only = current.moving.size === 1 ? [...current.moving.values()][0]!.item : null;
    if (only?.kind === "layer" && !last.modifiers.alt)
      throttled.current!.parent.schedule(only, last.client.x, last.client.y, last.point);
    else if (current.reparent) {
      throttled.current!.parent.cancel();
      current.reparent = null;
      gestureLayer.current?.container(null);
    }
    overlay.current?.preview({
      keys: current.boxes,
      dx: Math.round(delta.x),
      dy: Math.round(delta.y),
    });
  };

  const moveResize = (current: Extract<Gesture, { type: "resize" }>, last: Last) => {
    current.last = last;
    const delta = rotateDelta(worldDelta(current.world, last.point, false), current.angle);
    const result = resizeGeometry(current.origin, current.handle, delta, 1, {
      alt: last.modifiers.alt,
      shift: last.modifiers.shift,
      minSize: DESIGN_FRAME_MIN_SIZE,
    });
    current.result = result;
    previewResize(current, result);
  };

  // A wheel pan or zoom during a drag moves the world under a still pointer: follow it.
  const moves = useRef({ movePress, moveResize });
  useEffect(() => {
    moves.current = { movePress, moveResize };
  });
  useEffect(
    () =>
      camera.subscribe(() => {
        const current = gesture.current;
        if (current?.type === "press" && current.dragging && current.last)
          moves.current.movePress(current, current.last);
        if (current?.type === "resize" && current.last)
          moves.current.moveResize(current, current.last);
      }),
    [camera],
  );

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    moveGesture(event);
    if (gesture.current) markDragging(event);
  };

  const moveGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) {
      if (tool !== "move" || panning) return setHover(null);
      if ((event.target as HTMLElement).closest("[data-canvas-ui]")) return;
      const label =
        (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-frame-label]")?.dataset
          .canvasFrameLabel ?? null;
      // The hit test waits for a frame.
      throttled.current!.hover.schedule(
        { x: event.clientX, y: event.clientY },
        label,
        isMac ? event.metaKey : event.ctrlKey,
      );
      return;
    }
    if (current.pointer !== event.pointerId) return;
    const point = localPoint(event);
    const last: Last = {
      point,
      client: { x: event.clientX, y: event.clientY },
      modifiers: { shift: event.shiftKey, alt: event.altKey },
    };
    if (current.type === "pan") {
      const delta = { x: point.x - current.x, y: point.y - current.y };
      camera.preview({ ...current.view, x: current.view.x + delta.x, y: current.view.y + delta.y });
      return;
    }
    if (current.type === "press") {
      if (
        !current.dragging &&
        Math.hypot(point.x - current.x, point.y - current.y) < DRAG_THRESHOLD
      )
        return;
      lastClick.current = null;
      if (!current.dragging && current.deep) {
        // Cmd/Ctrl-drag selects with a marquee even over content.
        gesture.current = {
          type: "marquee",
          pointer: current.pointer,
          x: current.x,
          y: current.y,
          deep: true,
          prior: null,
          before: selection,
          last: point,
        };
        setGestureAttribute("marquee");
        throttled.current!.marquee.schedule(
          rectFromPoints(current.x, current.y, point.x, point.y),
          true,
          point,
        );
        return;
      }
      if (readOnly) return;
      if (!current.dragging) {
        current.dragging = true;
        setGestureAttribute("drag");
        const dragged = current.flow ? editor.elementFor(current.flow) : null;
        if (dragged) dragged.style.opacity = "0.3";
      }
      movePress(current, last);
      return;
    }
    if (current.type === "resize") return moveResize(current, last);
    if (current.type === "spacing") {
      const delta = worldDelta(current.world, point, false);
      current.value = spacingValue(current.origin, current.handle, delta, current.row);
      editor.previewStyles(
        [current.item],
        { [current.property]: `${current.value}px` },
        { quiet: true },
      );
      gestureLayer.current?.value(
        { label: current.handle === "gap" ? "gap" : "padding", meta: [String(current.value)] },
        point,
      );
      return;
    }
    if (current.type === "marquee") {
      // Holding Space moves the marquee with the pointer.
      if (input.spaceHeld()) {
        current.x += point.x - current.last.x;
        current.y += point.y - current.last.y;
      }
      current.last = point;
      if (Math.hypot(point.x - current.x, point.y - current.y) >= MARQUEE_THRESHOLD)
        lastClick.current = null;
      throttled.current!.marquee.schedule(
        rectFromPoints(current.x, current.y, point.x, point.y),
        current.deep,
        point,
      );
      return;
    }
    if (current.type === "draw" && current.tool !== "text") {
      // Space moves the origin with the pointer; Shift squares the box, Alt grows it from the
      // centre.
      if (input.spaceHeld()) {
        current.x += point.x - current.last.x;
        current.y += point.y - current.last.y;
      }
      current.last = point;
      current.modifiers = { shift: event.shiftKey, alt: event.altKey };
      gestureLayer.current?.draw(drawnRect(current, point, current.modifiers));
    }
  };

  const previewResize = (current: Extract<Gesture, { type: "resize" }>, result: ResizeResult) => {
    const { item, origin } = current;
    if (item.kind === "frame") {
      const next = clampFrameSize(result);
      place(current.wrapper, next);
      canvasLiveGeometry.set([[selectionKey(item), next]]);
      overlay.current?.preview({
        keys: new Set([selectionKey(item)]),
        dx: next.x - origin.x,
        dy: next.y - origin.y,
        dw: next.width - origin.width,
        dh: next.height - origin.height,
      });
      return;
    }
    const patch = resizePatch(current, result);
    canvasLiveGeometry.set([
      [
        selectionKey(item),
        {
          width: Math.round(result.width),
          height: Math.round(result.height),
          ...(current.free ? { x: Math.round(result.x), y: Math.round(result.y) } : {}),
        },
      ],
    ]);
    editor.previewStyles([item], patch, { quiet: true });
    throttled.current!.resize.schedule();
  };

  const finishGesture = async (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    gesture.current = null;
    release(event.pointerId);
    setGestureAttribute(null);
    if (cancelled) return revert(current);
    // The release point, not the last move: both can arrive before any frame is drawn.
    const point = localPoint(event);
    const last: Last = {
      point,
      client: { x: event.clientX, y: event.clientY },
      modifiers: { shift: event.shiftKey, alt: event.altKey },
    };
    if (current.type === "pan") return camera.commit();
    if (current.type === "comment") return input.onComment(current.pending);
    try {
      if (current.type === "press") return await finishPress(current, last);
      if (current.type === "resize") return await finishResize(current, last);
    } finally {
      canvasLiveGeometry.clear();
    }
    if (current.type === "spacing") {
      gestureLayer.current?.value(null);
      overlay.current?.settle();
      if (
        current.value !== current.origin &&
        !(await editor.commitStyles([current.item], { [current.property]: `${current.value}px` }))
      )
        editor.discardPreview([current.item]);
      return;
    }
    if (current.type === "marquee") {
      throttled.current!.marquee.cancel();
      gestureLayer.current?.marquee(null);
      if (input.spaceHeld()) {
        current.x += point.x - current.last.x;
        current.y += point.y - current.last.y;
      }
      const rect = rectFromPoints(current.x, current.y, point.x, point.y);
      const picked =
        Math.hypot(rect.width, rect.height) < MARQUEE_THRESHOLD
          ? []
          : marqueeItems(rect, current.deep);
      const next = current.prior ? toggleSelection(current.prior, picked) : picked;
      select(next, { from: current.before });
      return;
    }
    gestureLayer.current?.draw(null);
    setTool("move");
    if (input.spaceHeld()) {
      current.x += point.x - current.last.x;
      current.y += point.y - current.last.y;
    }
    await finishDraw(current, point, last.modifiers);
  };

  /** ⌥-drag: copies land where the drag ended; the originals go back. */
  const finishDuplicate = async (current: Extract<Gesture, { type: "press" }>, delta: Point) => {
    const created: CanvasSelectionItem[] = [];
    await editor.batch(async () => {
      if (current.flow) {
        const drop = resolveFlowDrop(
          editor,
          root.current!,
          current.flow,
          current.last?.client.x ?? 0,
          current.last?.client.y ?? 0,
        );
        const frame = editor.frame(current.flow.frameId);
        if (!drop || !frame) return;
        const result = await editor.run({
          kind: "edit",
          frameId: frame.id,
          operations: [
            {
              type: "insert_html",
              parentId: drop.parentId,
              ...(drop.beforeId ? { beforeId: drop.beforeId } : {}),
              html: restyledLayerHtml(frame, current.flow.layerId, {}),
            },
          ],
        });
        const id = result?.createdNodeIds[0];
        if (id) created.push({ kind: "layer", frameId: frame.id, layerId: id });
        return;
      }
      for (const { item, origin } of current.moving.values()) {
        const at = dragPosition(origin, delta, 1);
        const frame = editor.frame(item.frameId);
        if (!frame) continue;
        if (item.kind === "frame") {
          const id = canvasId("frame");
          const saved = await editor.run({
            kind: "restore",
            frames: [
              { ...structuredClone(frame), id, title: `${frame.title} copy`, ...at, revision: 1 },
            ],
            removeFrameIds: [],
          });
          if (saved) created.push({ kind: "frame", frameId: id });
          continue;
        }
        const result = await editor.run({
          kind: "edit",
          frameId: frame.id,
          operations: [
            {
              type: "insert_html",
              ...placementOf(frame.layers, item.layerId),
              html: restyledLayerHtml(frame, item.layerId, { left: `${at.x}px`, top: `${at.y}px` }),
            },
          ],
        });
        const id = result?.createdNodeIds[0];
        if (id) created.push({ kind: "layer", frameId: frame.id, layerId: id });
      }
      if (created.length) select(created);
    });
  };

  const finishPress = async (current: Extract<Gesture, { type: "press" }>, last: Last) => {
    throttled.current!.parent.cancel();
    gestureLayer.current?.container(null);
    if (current.flow) {
      throttled.current!.drop.cancel();
      gestureLayer.current?.drop(null);
      const dragged = editor.elementFor(current.flow);
      if (dragged) dragged.style.opacity = "";
      if (!current.dragging) {
        if (current.deep) select(current.items);
        else if (current.collapse) select([current.pressed]);
        return;
      }
      current.last = last;
      if (last.modifiers.alt) return finishDuplicate(current, { x: 0, y: 0 });
      const drop = resolveFlowDrop(
        editor,
        root.current!,
        current.flow,
        last.client.x,
        last.client.y,
      );
      if (!drop || isSameFlowPlace(editor, current.flow, drop)) return;
      await editor.run({
        kind: "edit",
        frameId: current.flow.frameId,
        operations: [
          {
            type: "move",
            nodeId: current.flow.layerId,
            parentId: drop.parentId,
            ...(drop.beforeId ? { beforeId: drop.beforeId } : {}),
          },
        ],
      });
      return;
    }
    if (!current.dragging) {
      if (current.deep) select(current.items);
      else if (current.collapse) select([current.pressed]);
      return;
    }
    const delta = worldDelta(current.world, last.point, last.modifiers.shift);
    if (last.modifiers.alt) {
      // The originals go back where they were; the copies take the dropped positions.
      for (const { item, origin, wrapper } of current.moving.values())
        if (item.kind === "frame") place(wrapper, origin);
        else editor.discardPreview([item]);
      overlay.current?.settle();
      return finishDuplicate(current, delta);
    }
    const framePatches: (CanvasFrameLayoutPatch & Point)[] = [];
    const layers: { item: LayerItem; at: Point }[] = [];
    for (const { item, origin } of current.moving.values()) {
      const at = dragPosition(origin, delta, 1);
      if (item.kind === "frame") framePatches.push({ id: item.frameId, ...at });
      else layers.push({ item, at });
    }
    // The moved frames stay where they were dropped until their save comes back.
    if (framePatches.length)
      setDrafts((existing) => {
        const next = { ...existing };
        for (const { id, x, y } of framePatches) next[id] = { ...next[id], x, y };
        return next;
      });
    for (const { item, at } of layers)
      editor.previewStyles([item], { left: `${at.x}px`, top: `${at.y}px` }, { quiet: true });
    // One free layer dropped over another container moves into it, where it was dropped.
    const reparent =
      layers.length === 1
        ? resolveParentDrop(editor, root.current!, layers[0]!.item, last.client.x, last.client.y)
        : null;
    const reparented = reparent ? reparentEdit(layers[0]!.item, reparent) : null;
    overlay.current?.settle();
    const failed: CanvasSelectionItem[] = [];
    let framesSaved = true;
    await editor.batch(async () => {
      if (reparented) {
        if (
          !(await editor.run({
            kind: "edit",
            frameId: layers[0]!.item.frameId,
            operations: reparented,
          }))
        )
          failed.push(layers[0]!.item);
      } else
        for (const { item, at } of layers)
          if (!(await editor.commitStyles([item], { left: `${at.x}px`, top: `${at.y}px` })))
            failed.push(item);
      if (framePatches.length)
        framesSaved = (await editor.run({ kind: "layout", frames: framePatches })) !== null;
    });
    // A refused save puts the canvas back to what is saved.
    if (failed.length) editor.discardPreview(failed);
    if (!framesSaved) dropDrafts(framePatches.map((patch) => patch.id));
    if (failed.length || !framesSaved) overlay.current?.settle();
  };

  /** The move into a new parent and the position that keeps the layer where it was dropped. */
  const reparentEdit = (item: LayerItem, target: ParentDrop): DesignLayerEdit[] | null => {
    const element = editor.elementFor(item);
    const frameRoot = editor.elementFor({ kind: "frame", frameId: item.frameId });
    const parent = target.parentId
      ? editor.elementFor({ kind: "layer", frameId: item.frameId, layerId: target.parentId })
      : frameRoot;
    if (!element || !frameRoot || !parent) return null;
    const at = offsetInParent(element, parent, frameRoot, camera.get().zoom);
    return [
      { type: "move", nodeId: item.layerId, parentId: target.parentId },
      { type: "set_styles", nodeId: item.layerId, styles: { left: `${at.x}px`, top: `${at.y}px` } },
    ];
  };

  const dropDrafts = (frameIds: readonly string[]) =>
    setDrafts((existing) => {
      const next = { ...existing };
      for (const id of frameIds) delete next[id];
      return next;
    });

  const finishResize = async (current: Extract<Gesture, { type: "resize" }>, last: Last) => {
    throttled.current!.resize.cancel();
    const delta = rotateDelta(worldDelta(current.world, last.point, false), current.angle);
    const result = resizeGeometry(current.origin, current.handle, delta, 1, {
      alt: last.modifiers.alt,
      shift: last.modifiers.shift,
      minSize: DESIGN_FRAME_MIN_SIZE,
    });
    const { item } = current;
    if (item.kind === "frame") {
      const next = clampFrameSize(result);
      setDrafts((existing) => ({
        ...existing,
        [item.frameId]: { ...existing[item.frameId], ...next },
      }));
      overlay.current?.settle();
      const saved = await editor.run({ kind: "layout", frames: [{ id: item.frameId, ...next }] });
      if (!saved) {
        dropDrafts([item.frameId]);
        overlay.current?.settle();
      }
      return;
    }
    const patch = resizePatch(current, result);
    editor.previewStyles([item], patch, { quiet: true });
    overlay.current?.settle();
    if (Object.keys(patch).length && !(await editor.commitStyles([item], patch))) {
      editor.discardPreview([item]);
      overlay.current?.settle();
    }
  };

  const finishDraw = async (
    current: Extract<Gesture, { type: "draw" }>,
    point: Point,
    modifiers: { shift: boolean; alt: boolean },
  ) => {
    const view = camera.get();
    const zoom = view.zoom;
    const clicked = Math.abs(point.x - current.x) < 4 && Math.abs(point.y - current.y) < 4;
    const rect = drawnRect(current, point, modifiers);
    const origin = screenToWorld(view, current.x, current.y);
    const located = frameAtPoint(frames, origin);
    if (current.tool === "text") {
      // Creating text and typing it is one undo step; an empty one leaves nothing.
      await editor.batch(async () => {
        if (located) {
          const created = await commands.insertIntoFrame(
            located.frame.id,
            `<p style="position:absolute;${TEXT_STYLE};white-space:pre-wrap;left:${Math.round(located.x)}px;top:${Math.round(located.y)}px">${input.newText}</p>`,
          );
          if (
            created &&
            text.start(
              { kind: "layer", frameId: located.frame.id, layerId: created.layerId },
              { work: created.work, created: true },
            )
          )
            await text.settled();
          return;
        }
        const created = await commands.createFrame(
          { x: origin.x, y: origin.y, width: 240, height: 48 },
          `<p style="${TEXT_STYLE};white-space:pre-wrap;padding:8px">${input.newText}</p>`,
        );
        if (
          created?.content &&
          text.start(
            { kind: "layer", frameId: created.frameId, layerId: created.content.layerId },
            { work: created.content.work, created: true, ownFrame: true },
          )
        )
          await text.settled();
      });
      return;
    }
    // A click without a drag makes a 100 × 100 box centred on it.
    const half = CANVAS_CLICK_DRAW_SIZE / 2;
    if (located) {
      const width = clicked ? CANVAS_CLICK_DRAW_SIZE : Math.round(rect.width / zoom);
      const height = clicked ? CANVAS_CLICK_DRAW_SIZE : Math.round(rect.height / zoom);
      const left = Math.round(clicked ? located.x - half : located.x + (rect.x - current.x) / zoom);
      const top = Math.round(clicked ? located.y - half : located.y + (rect.y - current.y) / zoom);
      const fill = current.tool === "rectangle" ? "#d9d9d9" : "#ffffff";
      await commands.insertIntoFrame(
        located.frame.id,
        `<div style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:${fill}"></div>`,
        { select: true },
      );
      return;
    }
    await commands.createFrame(
      clicked
        ? {
            x: origin.x - half,
            y: origin.y - half,
            width: CANVAS_CLICK_DRAW_SIZE,
            height: CANVAS_CLICK_DRAW_SIZE,
          }
        : screenToWorldRect(rect, view),
    );
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void finishGesture(event, false),
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void finishGesture(event, true),
    onPointerLeave: () => {
      throttled.current!.hover.cancel();
      setHover(null);
    },
    /** What a press at this point would select (the context menu's right-click). */
    hitAt: (clientX: number, clientY: number, deep: boolean) =>
      resolveHit(clientX, clientY, deep)?.item ?? null,
    /** Every layer under a point, deepest last (the context menu's "Select layer…"). */
    layersAt: (clientX: number, clientY: number) => {
      const hit = resolveHit(clientX, clientY, true);
      return hit ? { frameId: hit.frameId, layerIds: hit.stack } : null;
    },
    cancel,
    /** A pan owns the camera while it runs; the wheel waits. */
    panning: () => gesture.current?.type === "pan",
    active: () => gesture.current !== null,
  };
}
