import "../../../index.css";

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const key = (root: HTMLElement, init: KeyboardEventInit) =>
  root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

// f1 at the viewport's origin at 100% (400×300): a flex card with two buttons, a free badge,
// a 1px line, and a clipping box whose child overflows it.
const f1 = frameOf(
  "f1",
  [
    element(
      "card",
      "position:absolute;left:20px;top:20px;width:200px;height:100px;display:flex;gap:10px;padding:10px",
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
    element("line", "position:absolute;left:20px;top:200px;width:200px;height:1px;background:#000"),
    element(
      "clip",
      "position:absolute;left:250px;top:150px;width:60px;height:60px;overflow:hidden",
      ["inner"],
    ),
    element("inner", "position:absolute;left:0px;top:0px;width:140px;height:40px;background:#ccc"),
  ],
  ["card", "badge", "line", "clip"],
);
// An empty frame to the right.
const f2 = frameOf("f2", [], [], { x: 450, y: 0, width: 100, height: 100 });
const work = () => workOf([f1, f2]);

/** A press and release at one viewport-local point. */
function click(
  root: HTMLElement,
  target: Element,
  x: number,
  y: number,
  init: PointerEventInit = {},
) {
  const point = viewportPoint(root, x, y);
  pointer(target, "pointerdown", point.x, point.y, init);
  pointer(target, "pointerup", point.x, point.y, init);
}

async function drag(
  root: HTMLElement,
  target: Element,
  from: { x: number; y: number },
  steps: [number, number][],
  init: PointerEventInit = {},
) {
  const start = viewportPoint(root, from.x, from.y);
  pointer(target, "pointerdown", start.x, start.y, init);
  await nextFrame();
  for (const [dx, dy] of steps) {
    pointer(target, "pointermove", start.x + dx, start.y + dy, init);
    await nextFrame();
  }
  const [dx, dy] = steps.at(-1)!;
  pointer(target, "pointerup", start.x + dx, start.y + dy, init);
}

describe("hit test, click and drill", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("does not select a frame with layers by its body; its label or an empty frame does", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      click(root, host("f1"), 350, 280);
      await nextFrame();
      expect(selection()).toEqual([]);
      click(root, host("f2"), 500, 50);
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f2"]));
      mounted.editor!.setViewport({ x: 0, y: 60, zoom: 1 });
      await nextFrame();
      const label = root.querySelector('[data-canvas-frame-label="f1"]')!.getBoundingClientRect();
      const target = root.querySelector('[data-canvas-frame-label="f1"] span')!;
      pointer(target, "pointerdown", label.left + 10, label.top + label.height / 2);
      pointer(target, "pointerup", label.left + 10, label.top + label.height / 2);
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f1"]));
    } finally {
      await screen.unmount();
    }
  });

  it("hits a 1px line from 3px away (a 4px tolerance), but not from 6px", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      click(root, host("f1"), 100, 203);
      await vi.waitFor(() => expect(selection()).toEqual(["line"]));
      select([]);
      await nextFrame();
      await sleep(550);
      click(root, host("f1"), 100, 207);
      await nextFrame();
      expect(selection()).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps siblings one click away and never selects a locked layer, on canvas or in the panel", async () => {
    const locked = {
      ...f1,
      layers: {
        ...f1.layers,
        nodes: f1.layers.nodes.map((node) =>
          node.id === "badge" && node.type === "element"
            ? { ...node, attributes: { ...node.attributes, "data-locked": "true" } }
            : node,
        ),
      },
    };
    serveCanvas(native, workOf([locked, f2]));
    const { screen, root, host } = await mountCanvas(workOf([locked, f2]), { layers: true });
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      await nextFrame();
      click(root, host("f1"), 110, 50);
      await vi.waitFor(() => expect(selection()).toEqual(["two"]));
      await sleep(550);
      click(root, host("f1"), 270, 40);
      await nextFrame();
      expect(selection()).toEqual([]);
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      const row = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-layer-row="layer:f1:badge"]');
        expect(found).toBeTruthy();
        return found!;
      });
      row.click();
      await nextFrame();
      expect(selection()).toEqual(["one"]);
    } finally {
      await screen.unmount();
    }
  });

  it("drills on a second press within 500 ms and 5 px; Shift keeps the selection", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      // On the clip box's child: the first click selects the box, the second drills into it.
      click(root, host("f1"), 270, 160, { shiftKey: true });
      await vi.waitFor(() => expect(selection()).toEqual(["badge", "clip"]));
      click(root, host("f1"), 272, 161, { shiftKey: true });
      await vi.waitFor(() => expect(selection()).toEqual(["badge", "inner"]));
      // Too far apart: two single clicks.
      select([]);
      await sleep(550);
      click(root, host("f1"), 270, 160);
      await vi.waitFor(() => expect(selection()).toEqual(["clip"]));
      click(root, host("f1"), 285, 160);
      await nextFrame();
      expect(selection()).toEqual(["clip"]);
    } finally {
      await screen.unmount();
    }
  });

  it("edits deep text directly on a double-click", async () => {
    serveCanvas(native, work());
    const { screen, root, host, layer } = await mountCanvas(work());
    try {
      click(root, host("f1"), 55, 50);
      click(root, host("f1"), 55, 50);
      await vi.waitFor(() => expect(mounted.editor!.editingText?.layerId).toBe("one"));
      await vi.waitFor(() =>
        expect(layer("one")!.getAttribute("contenteditable")).toBe("plaintext-only"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("renames a frame inline from its label", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      mounted.editor!.setViewport({ x: 0, y: 60, zoom: 1 });
      await nextFrame();
      const label = root.querySelector('[data-canvas-frame-label="f1"] span')!;
      const box = label.getBoundingClientRect();
      for (let at = 0; at < 2; at++) {
        pointer(label, "pointerdown", box.left + 5, box.top + 5);
        pointer(label, "pointerup", box.left + 5, box.top + 5);
      }
      const input = await vi.waitFor(() => {
        const field = root.querySelector<HTMLInputElement>('[data-canvas-frame-label="f1"] input');
        expect(field).toBeTruthy();
        return field!;
      });
      input.value = "Home";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.blur();
      await vi.waitFor(() =>
        expect(native.canvas.layout).toHaveBeenCalledWith(
          expect.objectContaining({ frames: [{ id: "f1", title: "Home" }] }),
        ),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("starts a drag after 5 px, not before", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      const start = viewportPoint(root, 270, 40);
      pointer(layer("badge")!, "pointerdown", start.x, start.y);
      pointer(layer("badge")!, "pointermove", start.x + 4, start.y);
      await nextFrame();
      expect(layer("badge")!.style.left).toBe("250px");
      pointer(layer("badge")!, "pointermove", start.x + 6, start.y);
      await nextFrame();
      expect(layer("badge")!.style.left).toBe("256px");
      pointer(layer("badge")!, "pointerup", start.x + 6, start.y);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
    } finally {
      await screen.unmount();
    }
  });
});

describe("marquee", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("selects only frames once it holds a whole one, and toggles with Shift", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      // From empty canvas below f2, over all of f2 and part of f1.
      await drag(root, root, { x: 580, y: 120 }, [
        [-100, -60],
        [-200, -130],
      ]);
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f1", "frame:f2"]));
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      // Shift-marquee from below f1 over the badge and the clip box: the badge toggles off.
      await drag(
        root,
        root,
        { x: 330, y: 310 },
        [
          [-20, -100],
          [-90, -300],
        ],
        { shiftKey: true },
      );
      await vi.waitFor(() => expect(selection()).toEqual(["clip"]));
    } finally {
      await screen.unmount();
    }
  });

  it("does nothing under 5 px and moves with Space held", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      await drag(root, root, { x: 580, y: 380 }, [[-2, -2]]);
      await nextFrame();
      expect(selection()).toEqual([]);
      // A marquee from the frame's lower right; Space then carries it up over the badge.
      const start = viewportPoint(root, 330, 260);
      pointer(root, "pointerdown", start.x, start.y);
      pointer(root, "pointermove", start.x - 20, start.y - 20);
      await nextFrame();
      key(root, { key: " ", code: "Space" });
      await nextFrame();
      pointer(root, "pointermove", start.x - 20, start.y - 160);
      await nextFrame();
      window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space" }));
      await nextFrame();
      pointer(root, "pointermove", start.x - 60, start.y - 230);
      await nextFrame();
      pointer(root, "pointerup", start.x - 60, start.y - 230);
      // Moved, the box spans 270..330 × 30..120: the badge, not the clip box below it.
      await vi.waitFor(() => expect(selection()).toEqual(["badge"]));
    } finally {
      await screen.unmount();
    }
  });

  it("respects clipping and skips hidden and locked layers", async () => {
    const flagged = {
      ...f1,
      layers: {
        ...f1.layers,
        nodes: f1.layers.nodes.map((node) =>
          node.type !== "element"
            ? node
            : node.id === "badge"
              ? { ...node, attributes: { ...node.attributes, "data-hidden": "true" } }
              : node.id === "line"
                ? { ...node, attributes: { ...node.attributes, "data-locked": "true" } }
                : node,
        ),
      },
    };
    serveCanvas(native, workOf([flagged, f2]));
    const { screen, root } = await mountCanvas(workOf([flagged, f2]));
    try {
      // A Cmd marquee over only the clipped-away part of "inner" selects nothing.
      await drag(
        root,
        root,
        { x: 390, y: 185 },
        [
          [-20, -10],
          [-75, -30],
        ],
        mod,
      );
      await nextFrame();
      expect(selection()).toEqual([]);
      await sleep(550);
      // Over everything: hidden and locked layers stay out, a contained box is picked whole.
      await drag(
        root,
        root,
        { x: 395, y: 290 },
        [
          [-20, -20],
          [-385, -280],
        ],
        mod,
      );
      await vi.waitFor(() => expect(selection()).toEqual(["card", "clip"]));
    } finally {
      await screen.unmount();
    }
  });
});

describe("handles and outlines", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("draws four 7×7 corners, invisible edges and a W × H badge in the canvas accent", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      await vi.waitFor(() => expect(root.querySelector('[data-canvas-handle="se"]')).toBeTruthy());
      await nextFrame();
      for (const corner of ["nw", "ne", "sw", "se"]) {
        const box = root.querySelector(`[data-canvas-handle="${corner}"]`)!.getBoundingClientRect();
        expect([box.width, box.height]).toEqual([7, 7]);
      }
      const edges = root.querySelectorAll<HTMLElement>('[data-canvas-handle="e"]');
      expect(edges).toHaveLength(1);
      expect(getComputedStyle(edges[0]!).borderTopWidth).toBe("0px");
      const badge = root.querySelector<HTMLElement>(
        "[data-canvas-selection-group] > div:last-child",
      )!;
      expect(badge.textContent).toBe("400 × 300");
      // The selection blue is fixed: the user's accent colour and the theme never change it.
      const accent = getComputedStyle(root).getPropertyValue("--canvas-accent").trim();
      expect(accent).not.toBe("");
      const badgeColor = getComputedStyle(badge).backgroundColor;
      expect(badgeColor).not.toBe("rgba(0, 0, 0, 0)");
      const html = document.documentElement;
      html.style.setProperty("--color-text-accent", "rgb(255, 0, 0)");
      html.style.setProperty("--info", "rgb(255, 0, 0)");
      html.classList.add("dark");
      try {
        expect(getComputedStyle(root).getPropertyValue("--canvas-accent").trim()).toBe(accent);
        expect(getComputedStyle(badge).backgroundColor).toBe(badgeColor);
      } finally {
        html.style.removeProperty("--color-text-accent");
        html.style.removeProperty("--info");
        html.classList.remove("dark");
      }
    } finally {
      await screen.unmount();
    }
  });

  it("turns the handles with a rotated layer and bounds a multi-selection", async () => {
    const rotated = {
      ...f1,
      layers: {
        ...f1.layers,
        nodes: f1.layers.nodes.map((node) =>
          node.id === "badge" && node.type === "element"
            ? element("badge", `${node.attributes.style};rotate:30deg`)
            : node,
        ),
      },
    };
    serveCanvas(native, workOf([rotated]));
    const { screen, root } = await mountCanvas(workOf([rotated]));
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await vi.waitFor(() =>
        expect(
          root.querySelector<HTMLElement>("[data-canvas-selection-outline]")?.parentElement?.style
            .transform,
        ).toBe("rotate(30deg)"),
      );
      const outline = root.querySelector("[data-canvas-selection-outline]")!;
      // The unrotated 40×40 box, turned.
      expect((outline as HTMLElement).offsetWidth).toBe(40);
      select([
        { kind: "layer", frameId: "f1", layerId: "card" },
        { kind: "layer", frameId: "f1", layerId: "line" },
      ]);
      await vi.waitFor(() =>
        expect(root.querySelector("[data-canvas-selection-bounds]")).toBeTruthy(),
      );
      const bounds = root.querySelector("[data-canvas-selection-bounds]")!.getBoundingClientRect();
      expect([Math.round(bounds.width), Math.round(bounds.height)]).toEqual([200, 181]);
    } finally {
      await screen.unmount();
    }
  });

  it("drags a flex gap handle with a live preview and saves the gap once", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "card" }]);
      await vi.waitFor(() =>
        expect(root.querySelectorAll("[data-canvas-spacing]")).toHaveLength(5),
      );
      const gap = root.querySelector<HTMLElement>('[data-canvas-spacing="gap"]')!;
      const box = gap.getBoundingClientRect();
      // Between the buttons: 20 + 10 + 60 + 5 = 95 on screen.
      expect(Math.round(box.left + box.width / 2 - root.getBoundingClientRect().left)).toBe(95);
      pointer(gap, "pointerdown", box.left + 4, box.top + 4);
      await nextFrame();
      mounted.commits = 0;
      for (const dx of [4, 8, 12]) {
        pointer(gap, "pointermove", box.left + 4 + dx, box.top + 4);
        await nextFrame();
      }
      expect(mounted.commits).toBe(0);
      expect(layer("card")!.style.columnGap).toBe("22px");
      pointer(gap, "pointerup", box.left + 16, box.top + 4);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0]).toMatchObject({
        edit: {
          operations: [{ type: "set_styles", nodeId: "card", styles: { "column-gap": "22px" } }],
        },
      });
    } finally {
      await screen.unmount();
    }
  });
});

describe("drag", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("follows the world: a wheel pan during a drag keeps the layer under the pointer", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      const start = viewportPoint(root, 270, 40);
      pointer(layer("badge")!, "pointerdown", start.x, start.y);
      pointer(layer("badge")!, "pointermove", start.x + 10, start.y);
      await nextFrame();
      expect(layer("badge")!.style.left).toBe("260px");
      root.dispatchEvent(
        new WheelEvent("wheel", { deltaX: 30, deltaY: 0, bubbles: true, cancelable: true }),
      );
      await nextFrame();
      // The world moved 30px left under a still pointer: the layer moved 30px right in it.
      expect(layer("badge")!.style.left).toBe("290px");
      pointer(layer("badge")!, "pointerup", start.x + 10, start.y);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0]).toMatchObject({
        edit: { operations: [{ styles: { left: "290px", top: "20px" } }] },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps to one axis with Shift and duplicates with ⌥", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      await drag(
        root,
        layer("badge")!,
        { x: 270, y: 40 },
        [
          [10, 3],
          [40, 12],
        ],
        { shiftKey: true },
      );
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0]).toMatchObject({
        edit: { operations: [{ styles: { left: "290px", top: "20px" } }] },
      });
      await vi.waitFor(() => expect(layer("badge")!.style.left).toBe("290px"));
      await sleep(550);
      await drag(
        root,
        layer("badge")!,
        { x: 300, y: 40 },
        [
          [0, 20],
          [0, 60],
        ],
        { altKey: true },
      );
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      const insert = native.canvas.editLayers.mock.calls[1]![0].edit.operations[0];
      expect(insert).toMatchObject({ type: "insert_html", parentId: null, beforeId: "line" });
      expect(insert.html).toContain("top:80px");
      // The original stays put; the copy is selected.
      await vi.waitFor(() => expect(selection()).not.toEqual(["badge"]));
      expect(server.frame("f1").layers.nodes.find((node) => node.id === "badge")).toMatchObject({
        attributes: { style: expect.stringContaining("top:20px") },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("moves an absolute layer into the container it is dropped on", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      // The badge (250,20) over the card's lower right (card 20..220 × 20..120).
      await drag(root, layer("badge")!, { x: 255, y: 25 }, [
        [-20, 40],
        [-60, 70],
      ]);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0].edit.operations).toEqual([
        { type: "move", nodeId: "badge", parentId: "card" },
        { type: "set_styles", nodeId: "badge", styles: { left: "170px", top: "70px" } },
      ]);
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.find((node) => node.id === "card")).toMatchObject({
          children: ["one", "two", "badge"],
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("records selection changes as undo steps", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      root.focus();
      click(root, host("f1"), 270, 40);
      await vi.waitFor(() => expect(selection()).toEqual(["badge"]));
      await sleep(550);
      click(root, host("f1"), 50, 50);
      await vi.waitFor(() => expect(selection()).toEqual(["card"]));
      key(root, { key: "z", code: "KeyZ", ...mod });
      await vi.waitFor(() => expect(selection()).toEqual(["badge"]));
      key(root, { key: "z", code: "KeyZ", ...mod });
      await vi.waitFor(() => expect(selection()).toEqual([]));
      key(root, { key: "z", code: "KeyZ", shiftKey: true, ...mod });
      await vi.waitFor(() => expect(selection()).toEqual(["badge"]));
      expect(useCanvasEditorStore.getState().tool).toBe("move");
    } finally {
      await screen.unmount();
    }
  });
});

const enter = (target: Element, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
  );

describe("text editing", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("puts the Text tool's caret into existing text, and T edits a selected text layer", async () => {
    serveCanvas(native, work());
    const { screen, root, host, layer } = await mountCanvas(work());
    try {
      useCanvasEditorStore.getState().setTool("text");
      await nextFrame();
      click(root, host("f1"), 45, 50);
      await vi.waitFor(() => expect(mounted.editor!.editingText?.layerId).toBe("one"));
      await vi.waitFor(() => expect(layer("one")!.isContentEditable).toBe(true));
      expect(useCanvasEditorStore.getState().tool).toBe("move");
      expect(document.getSelection()!.isCollapsed).toBe(true);
      enter(layer("one")!);
      await vi.waitFor(() => expect(mounted.editor!.editingText).toBeNull());
      select([{ kind: "layer", frameId: "f1", layerId: "two" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "t", code: "KeyT" });
      await vi.waitFor(() => expect(mounted.editor!.editingText?.layerId).toBe("two"));
      expect(useCanvasEditorStore.getState().tool).toBe("move");
    } finally {
      await screen.unmount();
    }
  });

  it("moves between text layers with Tab and ⇧Tab", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "Enter", code: "Enter" });
      await vi.waitFor(() => expect(layer("one")!.isContentEditable).toBe(true));
      layer("one")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(layer("two")!.isContentEditable).toBe(true));
      expect(mounted.editor!.editingText?.layerId).toBe("two");
      layer("two")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => expect(mounted.editor!.editingText?.layerId).toBe("one"));
      // Nothing was typed, so nothing was saved.
      expect(native.canvas.editLayers).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("deletes a layer left empty in the same step, and keeps typed line breaks", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "two" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "Enter", code: "Enter" });
      await vi.waitFor(() => expect(layer("two")!.isContentEditable).toBe(true));
      layer("two")!.replaceChildren("A", document.createElement("br"), "B");
      enter(layer("two")!);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0].edit.operations).toEqual([
        { type: "set_text", nodeId: "twoText", text: "A\nB" },
        { type: "set_styles", nodeId: "two", styles: { "white-space": "pre-wrap" } },
      ]);
      await vi.waitFor(() => expect(getComputedStyle(layer("two")!).whiteSpace).toBe("pre-wrap"));
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      await nextFrame();
      key(root, { key: "Enter", code: "Enter" });
      await vi.waitFor(() => expect(layer("one")!.isContentEditable).toBe(true));
      layer("one")!.textContent = "";
      enter(layer("one")!);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(native.canvas.editLayers.mock.calls[1]![0].edit.operations).toEqual([
        { type: "delete", nodeId: "one" },
      ]);
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.some((node) => node.id === "one")).toBe(true),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("creates and types text as one undo step; an empty new text leaves nothing", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      useCanvasEditorStore.getState().setTool("text");
      await nextFrame();
      click(root, host("f1"), 330, 270);
      await vi.waitFor(() => expect(mounted.editor!.editingText).not.toBeNull());
      const created = mounted.editor!.editingText!.layerId;
      const editing = await vi.waitFor(() => {
        const found = host("f1").shadowRoot!.querySelector<HTMLElement>("[contenteditable]");
        expect(found).toBeTruthy();
        return found!;
      });
      editing.textContent = "Hi";
      enter(editing);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.some((node) => node.id === created)).toBe(false),
      );
      // A second Text-tool click left empty: the layer goes and no undo step is left behind.
      useCanvasEditorStore.getState().setTool("text");
      await nextFrame();
      click(root, host("f1"), 330, 240);
      const empty = await vi.waitFor(() => {
        const found = host("f1").shadowRoot!.querySelector<HTMLElement>("[contenteditable]");
        expect(found).toBeTruthy();
        return found!;
      });
      const emptyId = mounted.editor!.editingText!.layerId;
      empty.textContent = "";
      enter(empty);
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.some((node) => node.id === emptyId)).toBe(false),
      );
      // No step was recorded for it: the first text's undo can still be redone.
      await mounted.editor!.redo();
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.some((node) => node.id === created)).toBe(true),
      );
      expect(server.frame("f1").layers.nodes.some((node) => node.id === emptyId)).toBe(false);
    } finally {
      await screen.unmount();
    }
  });
});
