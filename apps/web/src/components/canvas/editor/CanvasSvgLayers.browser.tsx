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
    fontCatalog: vi.fn(),
    addFont: vi.fn(),
  },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import type { DesignLayer } from "@synara/contracts";
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
const key = (root: HTMLElement, init: KeyboardEventInit) =>
  root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

const svgNode = (
  id: string,
  tag: string,
  attributes: Record<string, string>,
  children: string[] = [],
): DesignLayer => ({ id, type: "element", tag, attributes, children });

// f1 at the viewport's origin at 100%: a 48×48 icon at 40,40 whose top-left quarter is painted
// with currentColor (a gradient in its defs), and a label beside it.
const f1 = frameOf(
  "f1",
  [
    svgNode(
      "icon",
      "svg",
      {
        viewBox: "0 0 24 24",
        style: "position:absolute;left:40px;top:40px;width:48px;height:48px",
        "data-name": "Star",
      },
      ["defs", "group"],
    ),
    svgNode("defs", "defs", {}, ["grad"]),
    svgNode("grad", "linearGradient", { id: "g" }, ["stop"]),
    svgNode("stop", "stop", { offset: "0", "stop-color": "#00ff00" }),
    svgNode("group", "g", {}, ["shape"]),
    svgNode("shape", "path", { d: "M0 0h12v12H0z", fill: "currentColor" }),
    element(
      "label",
      "position:absolute;left:120px;top:40px;width:80px;height:20px",
      ["labelText"],
      "p",
    ),
    text("labelText", "Star"),
  ],
  ["icon", "label"],
  { style: "background:#ffffff;color:#ff0000" },
);
const work = () => workOf([f1]);

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

function paste(value: string) {
  const data = new DataTransfer();
  data.setData("text/plain", value);
  document.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
}

const svgsIn = (host: HTMLElement) => [...host.shadowRoot!.querySelectorAll("svg")];
const inspector = () =>
  document.querySelector<HTMLElement>('[role="region"][aria-label="Inspector"]');

describe("inline SVG layers in the editor", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("selects the whole SVG on a click, a Cmd-click and a double-click; one row in the panel", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work(), { layers: true });
    try {
      // On a painted shape.
      click(root, host("f1"), 46, 46);
      await vi.waitFor(() => expect(selection()).toEqual(["icon"]));
      // On its unpainted part: still inside the SVG's box.
      select([]);
      await nextFrame();
      click(root, host("f1"), 80, 80);
      await vi.waitFor(() => expect(selection()).toEqual(["icon"]));
      // Cmd picks the deepest layer, which is the SVG itself.
      select([]);
      await nextFrame();
      click(root, host("f1"), 46, 46, mod);
      await vi.waitFor(() => expect(selection()).toEqual(["icon"]));
      // A double-click does not drill into it.
      click(root, host("f1"), 46, 46);
      click(root, host("f1"), 46, 46);
      await nextFrame();
      expect(selection()).toEqual(["icon"]);
      // Enter selects children: an SVG has none to offer.
      key(root, { key: "Enter", code: "Enter" });
      await nextFrame();
      expect(selection()).toEqual(["icon"]);
      // The layers panel lists the SVG as one leaf row, and nothing inside it.
      const row = document.querySelector('[data-layer-row="layer:f1:icon"]');
      expect(row).toBeTruthy();
      expect(row!.textContent).toContain("Star");
      for (const inner of ["defs", "grad", "stop", "group", "shape"])
        expect(document.querySelector(`[data-layer-row="layer:f1:${inner}"]`), inner).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("resizes the SVG by its width and height with zero commits while the pointer moves", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "icon" }]);
      await vi.waitFor(() => expect(root.querySelector('[data-canvas-handle="se"]')).toBeTruthy());
      await nextFrame();
      const handle = root.querySelector('[data-canvas-handle="se"]')!;
      const start = handle.getBoundingClientRect();
      const x = start.left + start.width / 2;
      const y = start.top + start.height / 2;
      pointer(handle, "pointerdown", x, y);
      await nextFrame();
      mounted.commits = 0;
      for (const step of [8, 16, 24]) {
        pointer(handle, "pointermove", x + step, y + step);
        await nextFrame();
      }
      expect(mounted.commits).toBe(0);
      pointer(handle, "pointerup", x + 24, y + 24);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0].edit.operations).toEqual([
        { type: "set_styles", nodeId: "icon", styles: { width: "72px", height: "72px" } },
      ]);
      await vi.waitFor(() => {
        const box = svgsIn(host("f1"))[0]!.getBoundingClientRect();
        expect([box.width, box.height]).toEqual([72, 72]);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("duplicates the SVG whole, with its shapes and its own gradient scope", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "icon" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "d", code: "KeyD", ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      const operation = native.canvas.editLayers.mock.calls[0]![0].edit.operations[0];
      expect(operation).toMatchObject({ type: "insert_html", parentId: null, beforeId: "label" });
      expect(operation.html).toContain('<svg viewBox="0 0 24 24"');
      expect(operation.html).toContain('<linearGradient id="g">');
      expect(operation.html).toContain('<path d="M0 0h12v12H0z" fill="currentColor"></path>');
      await vi.waitFor(() => expect(svgsIn(host("f1"))).toHaveLength(2));
      const [original, copy] = svgsIn(host("f1"));
      const copyId = copy!.getAttribute("data-synara-layer-id")!;
      await vi.waitFor(() => expect(selection()).toEqual([copyId]));
      expect(copy!.querySelectorAll("path")).toHaveLength(1);
      // Each SVG renders its gradient under its own layer ID, so neither can reach the other's.
      expect(original!.querySelector("linearGradient")!.id).toBe("sc.icon.g");
      expect(copy!.querySelector("linearGradient")!.id).toBe(`sc.${copyId}.g`);
    } finally {
      await screen.unmount();
    }
  });

  it("pastes an SVG document as an SVG layer through the sanitizing insert", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work());
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      root.focus();
      await nextFrame();
      const document =
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="4" fill="#0000ff"/></svg>\n';
      paste(document);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0].edit.operations).toEqual([
        { type: "insert_html", parentId: null, html: document.trim() },
      ]);
      await vi.waitFor(() => expect(svgsIn(host("f1"))).toHaveLength(2));
      const pasted = svgsIn(host("f1"))[1]!;
      expect(pasted.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(pasted.querySelector("circle")!.getAttribute("fill")).toBe("#0000ff");
      // Pasting with the SVG selected lands beside it, never inside it.
      select([{ kind: "layer", frameId: "f1", layerId: "icon" }]);
      await nextFrame();
      paste(document);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(native.canvas.editLayers.mock.calls[1]![0].edit.operations[0]).toMatchObject({
        type: "insert_html",
        parentId: null,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the SVG's size, opacity and currentColor colour in the inspector, not text", async () => {
    serveCanvas(native, work());
    const { screen } = await mountCanvas(work(), { inspector: true });
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "icon" }]);
      await vi.waitFor(() => expect(inspector()?.textContent).toContain("SVG"));
      const width = inspector()!.querySelector<HTMLInputElement>('input[aria-label="Width"]');
      expect(width?.value).toBe("48");
      expect(inspector()!.querySelector('[aria-label="Opacity"]')).toBeTruthy();
      expect(inspector()!.querySelector('[aria-label="Text color"]')).toBeNull();
      expect(inspector()!.querySelector('[aria-label="Color"]')).toBeTruthy();
    } finally {
      await screen.unmount();
    }
  });
});
