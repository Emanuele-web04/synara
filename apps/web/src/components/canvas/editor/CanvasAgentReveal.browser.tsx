import "../../../index.css";

import type { DesignFrame } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

const native = vi.hoisted(() => ({
  canvas: {
    editLayers: vi.fn(),
    layout: vi.fn(),
    restoreFrames: vi.fn(),
    get: vi.fn(),
    getAsset: vi.fn(),
    setChatSelection: vi.fn(),
    fontCatalog: vi.fn(),
  },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { canvasWorkQueryKey } from "../canvasWorkCache";
import { useCanvasActivityStore } from "../canvasStores";
import { flushCanvasCameras } from "./canvasCamera";
import {
  element,
  frameOf,
  mountCanvas,
  mounted,
  nextFrame,
  pointer,
  resetCanvasStores,
  select,
  serveCanvas,
  text,
  viewportPoint,
  workOf,
} from "./canvasEditorTestHarness";
import { CANVAS_REVEAL_IDLE_MS } from "./useCanvasAgentReveal";

const f1 = frameOf(
  "f1",
  [
    element("title", "position:absolute;left:20px;top:20px;margin:0;font-size:20px", ["t"], "p"),
    text("t", "Pricing"),
  ],
  ["title"],
);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** An agent writing to `frameId` (or, with `ended`, the end of its turn). */
const activity = (frameId: string, ended = false) =>
  useCanvasActivityStore.getState().record({
    type: "activity",
    workId: "work1",
    pageId: "page1",
    frameIds: ended ? [] : [frameId],
    threadId: "agent-chat" as never,
    expiresAt: new Date(Date.now() + 40_000).toISOString(),
    kind: "write",
    ...(ended ? { ended: true } : {}),
  });

/** A frame's box on screen and whether any of it is inside the viewport. */
function onScreen(root: HTMLElement, frameId: string) {
  const host = document.querySelector<HTMLElement>(`[data-canvas-frame-id="${frameId}"]`)!;
  const box = host.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  return (
    box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom
  );
}

/** How much of a frame's area is inside the viewport (0 to 1). */
function visibleShare(root: HTMLElement, frameId: string) {
  const host = document.querySelector<HTMLElement>(`[data-canvas-frame-id="${frameId}"]`)!;
  const box = host.getBoundingClientRect();
  const view = root.getBoundingClientRect();
  const width = Math.max(0, Math.min(box.right, view.right) - Math.max(box.left, view.left));
  const height = Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top));
  return (width * height) / (box.width * box.height);
}

/**
 * Mounts f1, then adds the agent's new 200 × 150 frame with its left edge `fromRight` screen
 * pixels left of the viewport's right edge (negative: past the edge, wholly out of view).
 */
async function mountWithOffscreenFrame(fromRight = -40) {
  const base = workOf([f1]);
  serveCanvas(native, base);
  const mountedCanvas = await mountCanvas(base);
  await nextFrame();
  const camera = mounted.editor!.camera.get();
  const f2: DesignFrame = frameOf("f2", [], [], {
    title: "Mobile",
    x: Math.round((600 - fromRight - camera.x) / camera.zoom),
    width: 200,
    height: 150,
  });
  mountedCanvas.client.setQueryData(canvasWorkQueryKey("work1"), workOf([f1, f2]));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-canvas-frame-id="f2"]')).toBeTruthy(),
  );
  // Nothing the harness did counts as the user being at work.
  await wait(CANVAS_REVEAL_IDLE_MS + 50);
  return mountedCanvas;
}

describe("revealing what an agent works on", () => {
  beforeEach(async () => {
    await page.viewport(1200, 800);
    resetCanvasStores();
    useCanvasActivityStore.setState({ frames: {}, layers: {} });
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.canvas.fontCatalog.mockResolvedValue({ families: [], available: true });
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("brings an off-screen frame the agent writes into view, with the frames in view, once a turn", async () => {
    const { screen, root } = await mountWithOffscreenFrame();
    try {
      expect(onScreen(root, "f2")).toBe(false);
      const commits = mounted.commits;
      activity("f2");
      await vi.waitFor(() => expect(onScreen(root, "f2")).toBe(true));
      // The frames that were in view stay in view as context.
      expect(onScreen(root, "f1")).toBe(true);
      // Animated through the live camera: a render to start and one to save, not one per step.
      await wait(300);
      expect(mounted.commits - commits).toBeLessThanOrEqual(4);

      // The user looks elsewhere; the same turn writing to the same frame leaves them there.
      const away = { ...mounted.editor!.camera.get(), x: -5000 };
      mounted.editor!.setViewport(away);
      await nextFrame();
      await wait(CANVAS_REVEAL_IDLE_MS + 50);
      activity("f2");
      await wait(400);
      expect(mounted.editor!.camera.get().x).toBe(-5000);

      // A new turn reveals it again.
      activity("f2", true);
      activity("f2");
      await vi.waitFor(() => expect(onScreen(root, "f2")).toBe(true));
    } finally {
      await screen.unmount();
    }
  });

  it("reveals a frame showing only a sliver at the edge, and leaves a half-visible one", async () => {
    const sliver = await mountWithOffscreenFrame(16);
    try {
      expect(visibleShare(sliver.root, "f2")).toBeGreaterThan(0);
      expect(visibleShare(sliver.root, "f2")).toBeLessThan(0.25);
      activity("f2");
      await vi.waitFor(() => expect(visibleShare(sliver.root, "f2")).toBeCloseTo(1, 2));
    } finally {
      await sliver.screen.unmount();
    }
    resetCanvasStores();
    useCanvasActivityStore.setState({ frames: {}, layers: {} });
    flushCanvasCameras();
    localStorage.clear();

    const half = await mountWithOffscreenFrame(0);
    try {
      // Half of it on the canvas: in view enough, so the camera stays where the user put it.
      const camera = mounted.editor!.camera.get();
      const width = 200 * camera.zoom;
      half.client.setQueryData(
        canvasWorkQueryKey("work1"),
        workOf([
          f1,
          frameOf("f2", [], [], {
            title: "Mobile",
            x: Math.round((600 - width / 2 - camera.x) / camera.zoom),
            width: 200,
            height: 150,
          }),
        ]),
      );
      await vi.waitFor(() => expect(visibleShare(half.root, "f2")).toBeCloseTo(0.5, 1));
      activity("f2");
      await wait(400);
      expect(mounted.editor!.camera.get()).toEqual(camera);
    } finally {
      await half.screen.unmount();
    }
  });

  it("never moves the camera while the user types into a text layer or drags", async () => {
    const { screen, root, layer } = await mountWithOffscreenFrame();
    try {
      const before = mounted.editor!.camera.get();
      // Typing into a text layer (and long enough after the key that started it).
      select([{ kind: "layer", frameId: "f1", layerId: "title" }]);
      root.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(layer("title")!.isContentEditable).toBe(true));
      await wait(CANVAS_REVEAL_IDLE_MS + 50);
      activity("f2");
      await wait(400);
      expect(mounted.editor!.camera.get()).toEqual(before);
      expect(onScreen(root, "f2")).toBe(false);
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(mounted.editor!.editingText).toBeNull());

      // Mid-drag (a marquee from empty canvas), for longer than the idle window.
      activity("f2", true);
      const start = viewportPoint(root, 560, 380);
      pointer(root, "pointerdown", start.x, start.y);
      pointer(root, "pointermove", start.x - 40, start.y - 40);
      await wait(CANVAS_REVEAL_IDLE_MS + 50);
      activity("f2");
      await wait(400);
      expect(mounted.editor!.camera.get()).toEqual(before);
      pointer(root, "pointerup", start.x - 40, start.y - 40);
      await nextFrame();

      // Once the user lets go and the agent's next turn writes there, the frame is revealed.
      await wait(CANVAS_REVEAL_IDLE_MS + 50);
      activity("f2", true);
      activity("f2");
      await vi.waitFor(() => expect(onScreen(root, "f2")).toBe(true));
    } finally {
      await screen.unmount();
    }
  });
});
