import "../../../index.css";

import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  canvas: {
    editLayers: vi.fn(),
    layout: vi.fn(),
    restoreFrames: vi.fn(),
    get: vi.fn(),
    getAsset: vi.fn(),
    setChatSelection: vi.fn(),
  },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { useCanvasEditorStore } from "../canvasStores";
import { flushCanvasCameras } from "./canvasCamera";
import { canvasLiveGeometry } from "./canvasLiveGeometry";
import {
  element,
  frameOf,
  mountCanvas,
  mounted,
  nextFrame,
  pointer,
  resetCanvasStores,
  select,
  selection,
  serveCanvas,
  text,
  viewportPoint,
  workOf,
} from "./canvasEditorTestHarness";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = { metaKey: isMac, ctrlKey: !isMac };

// f1 at the viewport's origin at 100%: a card with two buttons in a row, and a free badge.
const f1 = frameOf(
  "f1",
  [
    element(
      "card",
      "position:absolute;left:20px;top:20px;width:200px;height:100px;display:flex;gap:10px",
      ["one", "two"],
    ),
    element("one", "width:60px;height:40px;background:#0000ff", ["oneText"], "button"),
    text("oneText", "One"),
    element("two", "width:60px;height:40px;background:#00ff00", ["twoText"], "button"),
    text("twoText", "Two"),
    element(
      "badge",
      "position:absolute;left:250px;top:20px;width:40px;height:40px;background:#f00",
    ),
  ],
  ["card", "badge"],
);
const work = () => workOf([f1]);

/** The single selection's outline, on screen. */
const selectionBox = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("[data-canvas-selection-outline]")!.getBoundingClientRect();
const world = (root: HTMLElement) => root.firstElementChild as HTMLElement;
const key = (root: HTMLElement, init: KeyboardEventInit) =>
  root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

async function moveIn(target: Element, from: { x: number; y: number }, steps: [number, number][]) {
  for (const [dx, dy] of steps) {
    pointer(target, "pointermove", from.x + dx, from.y + dy);
    await nextFrame();
  }
}

describe("canvas gestures render nothing while the pointer moves", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("pans by writing the camera to the DOM, and saves it once on release", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await vi.waitFor(() =>
        expect(root.querySelector("[data-canvas-selection-group]")).toBeTruthy(),
      );
      await nextFrame();
      useCanvasEditorStore.getState().setTool("hand");
      await nextFrame();
      const before = selectionBox(root);
      const start = viewportPoint(root, 500, 300);
      pointer(root, "pointerdown", start.x, start.y);
      await nextFrame();
      mounted.commits = 0;
      await moveIn(root, start, [
        [10, 5],
        [30, 10],
        [60, 20],
        [80, 40],
      ]);
      expect(mounted.commits).toBe(0);
      expect(world(root).style.transform).toBe("translate(80px, 40px) scale(1)");
      // The overlay follows the camera through its variables, without a render.
      const after = selectionBox(root);
      expect(after.left - before.left).toBeCloseTo(80, 0);
      expect(after.top - before.top).toBeCloseTo(40, 0);
      pointer(root, "pointerup", start.x + 80, start.y + 40);
      await vi.waitFor(() => expect(mounted.editor!.viewport).toEqual({ x: 80, y: 40, zoom: 1 }));
      expect(mounted.commits).toBeGreaterThan(0);
      expect(native.canvas.layout).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("drags a layer with a live preview and saves it once on drop", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await vi.waitFor(() =>
        expect(root.querySelector("[data-canvas-selection-group]")).toBeTruthy(),
      );
      await nextFrame();
      const before = selectionBox(root);
      const start = viewportPoint(root, 270, 40);
      pointer(layer("badge")!, "pointerdown", start.x, start.y);
      await nextFrame();
      mounted.commits = 0;
      await moveIn(layer("badge")!, start, [
        [5, 0],
        [20, 10],
        [40, 30],
      ]);
      expect(mounted.commits).toBe(0);
      expect(layer("badge")!.style.left).toBe("290px");
      expect(layer("badge")!.style.top).toBe("50px");
      const after = selectionBox(root);
      expect(after.left - before.left).toBeCloseTo(40, 0);
      expect(after.top - before.top).toBeCloseTo(30, 0);
      // The inspector's X and Y follow the drag through the live geometry, not a render.
      expect(canvasLiveGeometry.get().get("layer:f1:badge")).toEqual({ x: 290, y: 50 });
      pointer(layer("badge")!, "pointerup", start.x + 40, start.y + 30);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0]).toMatchObject({
        edit: {
          operations: [
            { type: "set_styles", nodeId: "badge", styles: { left: "290px", top: "50px" } },
          ],
        },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("drags a frame and resizes it without rendering until release", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      const wrapper = host("f1").parentElement!;
      // A frame with layers drags by its body once it is selected.
      select([{ kind: "frame", frameId: "f1" }]);
      await nextFrame();
      const start = viewportPoint(root, 350, 250);
      pointer(host("f1"), "pointerdown", start.x, start.y);
      await nextFrame();
      mounted.commits = 0;
      await moveIn(host("f1"), start, [
        [10, 10],
        [25, 15],
      ]);
      expect(mounted.commits).toBe(0);
      expect([wrapper.style.left, wrapper.style.top]).toEqual(["25px", "15px"]);
      pointer(host("f1"), "pointerup", start.x + 25, start.y + 15);
      await vi.waitFor(() => expect(native.canvas.layout).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(root.querySelector('[data-canvas-handle="se"]')).toBeTruthy());
      await nextFrame();

      const handle = root.querySelector('[data-canvas-handle="se"]')!;
      const corner = viewportPoint(root, 425, 315);
      pointer(handle, "pointerdown", corner.x, corner.y);
      await nextFrame();
      mounted.commits = 0;
      await moveIn(handle, corner, [
        [10, 10],
        [40, 20],
      ]);
      expect(mounted.commits).toBe(0);
      expect([wrapper.style.width, wrapper.style.height]).toEqual(["440px", "320px"]);
      expect(root.querySelector("[data-canvas-selection-group]")!.textContent).toContain(
        "440 × 320",
      );
      pointer(handle, "pointerup", corner.x + 40, corner.y + 20);
      await vi.waitFor(() => expect(native.canvas.layout).toHaveBeenCalledTimes(2));
      expect(native.canvas.layout.mock.calls[1]![0]).toMatchObject({
        frames: [{ id: "f1", x: 25, y: 15, width: 440, height: 320 }],
      });
    } finally {
      await screen.unmount();
    }
  });

  it("draws a marquee and its count without rendering, then selects on release", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      const start = viewportPoint(root, 560, 380);
      pointer(root, "pointerdown", start.x, start.y);
      await nextFrame();
      mounted.commits = 0;
      await moveIn(root, start, [
        [-100, -100],
        [-330, -350],
      ]);
      expect(mounted.commits).toBe(0);
      const layer = root.querySelector<HTMLElement>("[data-canvas-gesture-layer]")!;
      // The marquee, one box for what it would select, and the count chip.
      expect(layer.children).toHaveLength(3);
      expect(layer.textContent).toMatch(/1/);
      pointer(root, "pointerup", start.x - 330, start.y - 350);
      await vi.waitFor(() => expect(selection()).toEqual(["badge"]));
      expect(layer.children).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("zooms on the wheel without rendering, then commits once it settles", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      await nextFrame();
      mounted.commits = 0;
      for (let index = 0; index < 4; index++)
        root.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -10,
            ctrlKey: true,
            clientX: root.getBoundingClientRect().left,
            clientY: root.getBoundingClientRect().top,
            bubbles: true,
            cancelable: true,
          }),
        );
      await nextFrame();
      expect(mounted.commits).toBe(0);
      expect(world(root).style.transform).toMatch(/scale\(1\.49/);
      // The zoom menu's percentage follows without a render too.
      expect(root.textContent).toContain("149%");
      await vi.waitFor(() => expect(mounted.editor!.viewport.zoom).toBeCloseTo(1.4918, 3));
      expect(mounted.commits).toBeGreaterThan(0);
    } finally {
      await screen.unmount();
    }
  });

  it("Escape cancels a drag and puts the layer back", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      const start = viewportPoint(root, 270, 40);
      pointer(layer("badge")!, "pointerdown", start.x, start.y);
      await moveIn(layer("badge")!, start, [[30, 30]]);
      expect(layer("badge")!.style.left).toBe("280px");
      key(root, { key: "Escape", code: "Escape" });
      expect(layer("badge")!.style.left).toBe("250px");
      pointer(layer("badge")!, "pointerup", start.x + 30, start.y + 30);
      await nextFrame();
      expect(native.canvas.editLayers).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("reorders a flow layer inside its row by dragging it", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      await nextFrame();
      const start = viewportPoint(root, 50, 40);
      pointer(layer("one")!, "pointerdown", start.x, start.y);
      await moveIn(layer("one")!, start, [
        [20, 0],
        [80, 0],
      ]);
      expect(layer("one")!.style.opacity).toBe("0.3");
      pointer(layer("one")!, "pointerup", start.x + 80, start.y);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(layer("one")!.style.opacity).toBe("");
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.find((node) => node.id === "card")).toMatchObject({
          children: ["two", "one"],
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
});

describe("canvas overlay placement", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });

  it("places handles and the chip on the selection at any camera", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      const origin = root.getBoundingClientRect();
      const centre = (selector: string) => {
        const box = root.querySelector(selector)!.getBoundingClientRect();
        return {
          x: box.left - origin.left + box.width / 2,
          y: box.top - origin.top + box.height / 2,
        };
      };
      select([{ kind: "frame", frameId: "f1" }]);
      await vi.waitFor(() => expect(root.querySelector('[data-canvas-handle="se"]')).toBeTruthy());
      await nextFrame();
      expect(centre('[data-canvas-handle="se"]')).toEqual({ x: 400, y: 300 });
      expect(centre('[data-canvas-handle="nw"]')).toEqual({ x: 0, y: 0 });
      const edge = [...root.querySelectorAll('[data-canvas-handle="e"]')]
        .at(-1)!
        .getBoundingClientRect();
      expect(edge.left - origin.left + edge.width / 2).toBe(400);
      expect(edge.top - origin.top + edge.height / 2).toBe(150);
      mounted.editor!.setViewport({ x: 10, y: 20, zoom: 0.5 });
      await vi.waitFor(() =>
        expect(centre('[data-canvas-handle="se"]')).toEqual({ x: 210, y: 170 }),
      );
      const chip = root.querySelector("[data-canvas-selection-group] > div:last-child")!;
      expect(chip.textContent).toBe("400 × 300");
      expect(chip.getBoundingClientRect().top - origin.top).toBeCloseTo(177, 0);
    } finally {
      await screen.unmount();
    }
  });
});

describe("canvas keyboard", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });

  it("walks the tree: Enter selects children, Tab cycles siblings, Esc goes up", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "Enter", code: "Enter" });
      await vi.waitFor(() => expect(selection()).toEqual(["card", "badge"]));
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      await nextFrame();
      key(root, { key: "Tab", code: "Tab" });
      await vi.waitFor(() => expect(selection()).toEqual(["two"]));
      await nextFrame();
      key(root, { key: "Tab", code: "Tab" });
      await vi.waitFor(() => expect(selection()).toEqual(["one"]));
      await nextFrame();
      key(root, { key: "Escape", code: "Escape" });
      await vi.waitFor(() => expect(selection()).toEqual(["card"]));
      await nextFrame();
      key(root, { key: "a", code: "KeyA", ...mod });
      await vi.waitFor(() => expect(selection()).toEqual(["card", "badge"]));
    } finally {
      await screen.unmount();
    }
  });

  it("switches tools, zooms to 100% and ignores keys typed into fields", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      await userEvent.keyboard("h");
      expect(useCanvasEditorStore.getState().tool).toBe("hand");
      await userEvent.keyboard("v");
      expect(useCanvasEditorStore.getState().tool).toBe("move");
      mounted.editor!.setViewport({ x: 0, y: 0, zoom: 0.5 });
      await nextFrame();
      key(root, { key: ")", code: "Digit0", shiftKey: true });
      await vi.waitFor(() => expect(mounted.editor!.viewport.zoom).toBe(1));
      // A key typed into a field inside the canvas stays with the field.
      const field = document.createElement("input");
      root.append(field);
      field.focus();
      await userEvent.keyboard("r");
      expect(useCanvasEditorStore.getState().tool).toBe("move");
      field.remove();
    } finally {
      await screen.unmount();
    }
  });
});
