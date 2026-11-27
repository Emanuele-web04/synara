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
// Counts each layers panel row's renders, by its row key.
const rowRenders = vi.hoisted(() => new Map<string, number>());
vi.mock("../../ui/TreeRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui/TreeRow")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    TreeRow: (props: Parameters<typeof actual.TreeRow>[0]) => {
      const key = (props as { "data-layer-row"?: string })["data-layer-row"];
      if (key) rowRenders.set(key, (rowRenders.get(key) ?? 0) + 1);
      return createElement(actual.TreeRow, props);
    },
  };
});

import { useCanvasEditorStore } from "../canvasStores";
import { flushCanvasCameras } from "./canvasCamera";
import {
  element,
  frameOf,
  mountCanvas,
  nextFrame,
  pointer,
  resetCanvasStores,
  serveCanvas,
  viewportPoint,
  workOf,
} from "./canvasEditorTestHarness";

const f1 = frameOf(
  "f1",
  [
    element("card", "position:absolute;left:20px;top:20px;width:200px;height:100px"),
    element("badge", "position:absolute;left:250px;top:20px;width:40px;height:40px"),
    element("note", "position:absolute;left:20px;top:200px;width:80px;height:20px"),
  ],
  ["card", "badge", "note"],
);
const work = () => workOf([f1]);
const row = (key: string) => document.querySelector<HTMLElement>(`[data-layer-row="${key}"]`);
const hoveredRows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-layer-row][data-hovered]")].map(
    (item) => item.dataset.layerRow,
  );
/** Row renders since `before`, by key, leaving out rows that did not render. */
const rendersSince = (before: Map<string, number>) =>
  Object.fromEntries(
    [...rowRenders].flatMap(([key, count]) => {
      const added = count - (before.get(key) ?? 0);
      return added > 0 ? [[key, added]] : [];
    }),
  );

describe("layers panel hover from the canvas", () => {
  beforeEach(() => {
    resetCanvasStores();
    rowRenders.clear();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => flushCanvasCameras());

  it("marks the hovered layer's row, rendering only the rows that change", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work(), { layers: true });
    try {
      // The frame row's chevron opens it (nothing is selected).
      await vi.waitFor(() => expect(row("frame:f1")).toBeTruthy());
      row("frame:f1")!.querySelector("button")!.click();
      await vi.waitFor(() => expect(row("layer:f1:card")).toBeTruthy());
      await nextFrame();
      expect(hoveredRows()).toEqual([]);

      const move = async (x: number, y: number) => {
        const point = viewportPoint(root, x, y);
        pointer(root, "pointermove", point.x, point.y, { buttons: 0 });
        await nextFrame();
        await nextFrame();
      };
      let before = new Map(rowRenders);
      await move(60, 60);
      await vi.waitFor(() => expect(hoveredRows()).toEqual(["layer:f1:card"]));
      // The row takes the sidebar's hover fill, as a pointer over it would.
      expect(row("layer:f1:card")!.className).toContain("bg-[var(--sidebar-accent)]");
      expect(rendersSince(before)).toEqual({ "layer:f1:card": 1 });

      before = new Map(rowRenders);
      await move(270, 40);
      await vi.waitFor(() => expect(hoveredRows()).toEqual(["layer:f1:badge"]));
      // The row that lost the hover and the one that took it; no other row, nor the panel.
      expect(rendersSince(before)).toEqual({ "layer:f1:card": 1, "layer:f1:badge": 1 });

      // Moving within the same layer renders nothing.
      before = new Map(rowRenders);
      await move(275, 45);
      expect(rendersSince(before)).toEqual({});

      // Leaving the canvas clears it.
      // (React's pointer leave comes from a pointerout to an element outside it.)
      root.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
      await vi.waitFor(() => expect(hoveredRows()).toEqual([]));
      expect(useCanvasEditorStore.getState().canvasHover).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
