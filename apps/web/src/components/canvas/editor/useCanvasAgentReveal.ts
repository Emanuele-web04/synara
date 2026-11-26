// FILE: useCanvasAgentReveal.ts
// Purpose: The canvas shows what an agent is working on. When an agent starts writing to a frame
//          that is mostly out of view (under a quarter of it on the canvas: a new frame placed
//          off to the side, or only a sliver of it at an edge), the camera
//          brings it into view with the frames already in view as context, through the
//          animated camera. Never while the user is busy with the canvas, and at most once per
//          agent turn and frame.
// Layer: Canvas editor camera
// Exports: useCanvasAgentReveal, CANVAS_REVEAL_IDLE_MS

import type { DesignFrame, DesignViewport } from "@synara/contracts";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { canvasActivityKey, useCanvasActivityStore } from "../canvasStores";
import { INSPECTOR_ROOT_ATTRIBUTE } from "./canvasTextSession";
import type { useCanvasCameraCommands } from "./useCanvasCamera";

/** A press, key or wheel on the canvas this recently means the user is still at work. */
export const CANVAS_REVEAL_IDLE_MS = 1500;
/** A reveal that would zoom out below this share of the zoom drops the context frames. */
const MIN_CONTEXT_ZOOM_SHARE = 0.5;
/** A frame with less of its area than this on the canvas counts as out of view. */
export const CANVAS_REVEAL_MIN_VISIBLE_SHARE = 0.25;

type Rect = Pick<DesignFrame, "x" | "y" | "width" | "height">;

/**
 * The share of a frame's area inside the canvas element (the visible canvas: the side panels
 * and the inspector are its neighbours, not on top of it).
 */
const visibleShare = (rect: Rect, view: DesignViewport, width: number, height: number) => {
  const left = view.x + rect.x * view.zoom;
  const top = view.y + rect.y * view.zoom;
  const right = left + rect.width * view.zoom;
  const bottom = top + rect.height * view.zoom;
  const area = (right - left) * (bottom - top);
  if (area <= 0) return 0;
  const shownWidth = Math.max(0, Math.min(right, width) - Math.max(left, 0));
  const shownHeight = Math.max(0, Math.min(bottom, height) - Math.max(top, 0));
  return (shownWidth * shownHeight) / area;
};
const onScreen = (rect: Rect, view: DesignViewport, width: number, height: number) =>
  visibleShare(rect, view, width, height) > 0;

/** Focus in a field of the editor (the inspector, a rename, the canvas's own popups). */
function editingAField(root: HTMLElement): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (!active.isContentEditable && !active.matches("input, textarea, select")) return false;
  return (
    root.contains(active) ||
    active.closest(`[${INSPECTOR_ROOT_ATTRIBUTE}], [data-canvas-side-panel]`) !== null ||
    active.closest("[data-slot=popover-popup], [data-slot=menu-popup], [role=dialog]") !== null
  );
}

export function useCanvasAgentReveal({
  root,
  workId,
  pageId,
  frames,
  cameraPlaced,
  camera,
  commands,
  busy,
}: {
  root: RefObject<HTMLElement | null>;
  workId: string;
  pageId: string;
  /** The page's frames as shown (hidden ones left out). */
  frames: readonly (Rect & { id: string })[];
  /** False until this client placed the camera on the page (first-open fit comes first). */
  cameraPlaced: boolean;
  camera: { get: () => DesignViewport };
  commands: ReturnType<typeof useCanvasCameraCommands>;
  /** The user is mid-gesture, typing into a text layer or writing a comment. */
  busy: () => boolean;
}) {
  const latest = useRef({ frames, cameraPlaced, commands, busy });
  useLayoutEffect(() => {
    latest.current = { frames, cameraPlaced, commands, busy };
  });
  /** `threadId\nframeId` pairs already handled in the agent's current turn. */
  const handled = useRef(new Set<string>());
  const lastInput = useRef(0);
  const checkNow = useRef<() => void>(() => {});

  // Any press, key or wheel on the canvas counts as the user being at work.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const note = () => {
      lastInput.current = performance.now();
    };
    for (const type of ["pointerdown", "keydown", "wheel"] as const)
      element.addEventListener(type, note, { capture: true, passive: true });
    return () => {
      for (const type of ["pointerdown", "keydown", "wheel"] as const)
        element.removeEventListener(type, note, { capture: true });
    };
  }, [root]);

  const key = canvasActivityKey(workId, pageId);
  useEffect(() => {
    handled.current.clear();
    const check = () => {
      const element = root.current;
      const current = latest.current;
      if (!element) return;
      const entries = useCanvasActivityStore.getState().frames[key] ?? {};
      const now = Date.now();
      const live = Object.entries(entries).filter(([, entry]) => entry.expiresAt > now);
      // A thread with nothing left on the page has ended its turn: its next turn starts afresh.
      const threads = new Set(live.map(([, entry]) => entry.threadId as string));
      for (const pair of handled.current)
        if (!threads.has(pair.slice(0, pair.indexOf("\n")))) handled.current.delete(pair);
      for (const [frameId, entry] of live) {
        const pair = `${entry.threadId}\n${frameId}`;
        if (handled.current.has(pair)) continue;
        const frame = current.frames.find((item) => item.id === frameId);
        // The activity can arrive before the new frame does; look again when it lands.
        if (!frame) continue;
        handled.current.add(pair);
        const width = element.clientWidth;
        const height = element.clientHeight;
        const view = camera.get();
        if (!current.cameraPlaced || width < 40 || height < 40) continue;
        // Mostly in view already (a quarter or more of it): leave the camera alone.
        if (visibleShare(frame, view, width, height) >= CANVAS_REVEAL_MIN_VISIBLE_SHARE) continue;
        if (
          current.busy() ||
          editingAField(element) ||
          performance.now() - lastInput.current < CANVAS_REVEAL_IDLE_MS
        )
          continue;
        // The frames in view stay in view as context, unless that would zoom far out.
        const context = current.frames.filter(
          (item) => item.id !== frameId && onScreen(item, view, width, height),
        );
        const rects = [...context, frame];
        const zoomWithContext = Math.min(
          view.zoom,
          (width - 160) / Math.max(1, spanOf(rects, "x", "width")),
          (height - 160) / Math.max(1, spanOf(rects, "y", "height")),
        );
        current.commands.fit(
          zoomWithContext >= view.zoom * MIN_CONTEXT_ZOOM_SHARE ? rects : [frame],
          { maxZoom: view.zoom },
        );
      }
    };
    checkNow.current = check;
    check();
    return useCanvasActivityStore.subscribe(check);
    // `frames` is read through `latest`; a new frame re-runs the check below.
  }, [camera, key, root]);

  // The frame an agent is writing can land after its activity: check once it does.
  useEffect(() => checkNow.current(), [frames.length]);
}

function spanOf(rects: readonly Rect[], axis: "x" | "y", size: "width" | "height") {
  const start = Math.min(...rects.map((rect) => rect[axis]));
  const end = Math.max(...rects.map((rect) => rect[axis] + rect[size]));
  return end - start;
}
