// FILE: canvasCamera.ts
// Purpose: The camera belongs to each client, kept per page: it is
//          remembered in local storage per work and page, never written to the shared work.
//          The page's saved viewport is only where a client opens it the first time. While a
//          pan or zoom is in progress the camera lives outside React (createLiveCamera) and is
//          committed once the gesture settles.
// Layer: Canvas editor state
// Exports: canvasCameraKey, openCanvasCamera, readCanvasCamera, saveCanvasCamera,
//          flushCanvasCameras, boundCamera, createLiveCamera, CanvasCamera, CanvasLiveCamera

import { CANVAS_DEFAULT_VIEWPORT, type CanvasPage, type DesignViewport } from "@synara/contracts";
import { clampZoom } from "~/lib/designCanvas";
import { executionStorage } from "~/lib/hosts/executionStorage";
import { flushStorageBeforePageHide } from "~/lib/storage";

const STORAGE_KEY = "synara:canvas-cameras:v1";
/** Pages remembered per execution host; the least recently moved are forgotten first. */
const MAX_CAMERAS = 200;
const WRITE_DELAY_MS = 300;

export const canvasCameraKey = (workId: string, pageId: string) => `${workId}/${pageId}`;

/**
 * `placed` is false while the camera is only the untouched default of a never-placed page:
 * the viewport then fits the page's frames (or centres the origin) once it has a size.
 */
export type CanvasCamera = { key: string; viewport: DesignViewport; placed: boolean };

const coordinate = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;

function readAll(): Record<string, DesignViewport> {
  try {
    const parsed: unknown = JSON.parse(executionStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    const cameras: Record<string, DesignViewport> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const view = value as Partial<DesignViewport> | null;
      if (view && coordinate(view.x) && coordinate(view.y) && coordinate(view.zoom))
        cameras[key] = { x: view.x!, y: view.y!, zoom: clampZoom(view.zoom!) };
    }
    return cameras;
  } catch {
    return {};
  }
}

const pending = new Map<string, DesignViewport>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushOnHide = false;

/** Writes queued cameras, merged into what other windows stored meanwhile. */
export function flushCanvasCameras() {
  clearTimeout(timer);
  timer = undefined;
  if (pending.size === 0) return;
  const cameras = readAll();
  for (const [key, viewport] of pending) {
    delete cameras[key];
    cameras[key] = viewport;
  }
  pending.clear();
  const kept = Object.entries(cameras).slice(-MAX_CAMERAS);
  try {
    executionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* Storage can be full or refused; the camera is a convenience only. */
  }
}

export function readCanvasCamera(key: string): DesignViewport | null {
  return pending.get(key) ?? readAll()[key] ?? null;
}

/** Remembers a page's camera for this client. The key names the page the camera is on. */
export function saveCanvasCamera(key: string, viewport: DesignViewport) {
  pending.set(key, { x: viewport.x, y: viewport.y, zoom: viewport.zoom });
  if (!flushOnHide) {
    flushOnHide = true;
    flushStorageBeforePageHide(flushCanvasCameras);
  }
  clearTimeout(timer);
  timer = setTimeout(flushCanvasCameras, WRITE_DELAY_MS);
}

const isDefaultViewport = (view: DesignViewport) =>
  view.x === CANVAS_DEFAULT_VIEWPORT.x &&
  view.y === CANVAS_DEFAULT_VIEWPORT.y &&
  view.zoom === CANVAS_DEFAULT_VIEWPORT.zoom;

/** Where this client opens a page: its own last camera, else the page's saved default. */
export function openCanvasCamera(workId: string, page: Pick<CanvasPage, "id" | "viewport">) {
  const key = canvasCameraKey(workId, page.id);
  const stored = readCanvasCamera(key);
  if (stored) return { key, viewport: stored, placed: true } satisfies CanvasCamera;
  return {
    key,
    viewport: page.viewport,
    placed: !isDefaultViewport(page.viewport),
  } satisfies CanvasCamera;
}

const CAMERA_LIMIT = 1_000_000;

/** Keeps a camera's position within what a work can store. */
export const boundCamera = (viewport: DesignViewport): DesignViewport => ({
  ...viewport,
  x: Math.max(-CAMERA_LIMIT, Math.min(CAMERA_LIMIT, viewport.x)),
  y: Math.max(-CAMERA_LIMIT, Math.min(CAMERA_LIMIT, viewport.y)),
});

/**
 * The camera as the canvas shows it. A pan or wheel zoom previews here, outside React: the
 * viewport writes it to the DOM as it changes, and nothing re-renders until it is committed.
 */
export type CanvasLiveCamera = {
  /** What the canvas shows right now, a preview included. */
  get: () => DesignViewport;
  /** Moves the camera on screen only. */
  preview: (viewport: DesignViewport) => void;
  /** Saves a previewed camera for the page it was previewed on. */
  commit: () => void;
  /** Drops a preview and shows the saved camera again. */
  revert: () => void;
  subscribe: (listener: (viewport: DesignViewport) => void) => () => void;
  /**
   * The saved camera of `key` is now `viewport` (a commit, a fit, a page switch). A preview
   * still pending on another page is saved for that page first, never for this one.
   */
  sync: (key: string, viewport: DesignViewport) => void;
};

export function createLiveCamera(
  key: string,
  viewport: DesignViewport,
  save: (key: string, viewport: DesignViewport) => void,
): CanvasLiveCamera {
  let state = { key, viewport, saved: viewport, dirty: false };
  const listeners = new Set<(viewport: DesignViewport) => void>();
  const notify = () => {
    for (const listener of listeners) listener(state.viewport);
  };
  return {
    get: () => state.viewport,
    preview: (next) => {
      state = { ...state, viewport: boundCamera(next), dirty: true };
      notify();
    },
    commit: () => {
      if (!state.dirty) return;
      state = { ...state, dirty: false };
      save(state.key, state.viewport);
    },
    revert: () => {
      state = { ...state, viewport: state.saved, dirty: false };
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync: (nextKey, next) => {
      if (state.key !== nextKey && state.dirty) save(state.key, state.viewport);
      state = { key: nextKey, viewport: next, saved: next, dirty: false };
      notify();
    },
  };
}
