import "../../../index.css";

import type { CanvasCommentThread, CanvasEditLayersInput, CanvasWork } from "@synara/contracts";
import { serializeDesignLayers } from "@synara/shared/designCanvasLayers";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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

import { fitDesignCanvas } from "~/lib/designCanvas";
import { SidebarProvider } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { useCanvasEditorStore } from "../canvasStores";
import { canvasWorkQueryKey, canvasWorkQueryOptions } from "../canvasWorkCache";
import { CanvasEditorProvider, useCanvasEditor, type CanvasEditorApi } from "./CanvasEditorContext";
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

// f1 at the viewport's origin, 400×300 at 100%: every layer's screen point is its frame point.
const f1 = frameOf(
  "f1",
  [
    element("a", "position:absolute;left:10px;top:10px;width:50px;height:50px;background:#0000ff"),
    element("b", "position:absolute;left:100px;top:10px;width:50px;height:50px;background:#00ff00"),
    element("c", "position:absolute;left:10px;top:120px;margin:0;font-size:16px", ["ct"], "p"),
    text("ct", "Hello"),
    element(
      "e",
      "position:absolute;left:10px;top:200px;width:80px;height:20px;margin:0;font-size:16px",
      [],
      "p",
    ),
    element(
      "m",
      "position:absolute;left:10px;top:250px;width:20px;height:20px;margin:8px;background:#ff0000",
    ),
    element("h", "position:absolute;left:300px;top:10px;width:40px;height:40px", [], "div", {
      "data-hidden": "true",
    }),
    element("x", "position:fixed;left:200px;top:100px;width:40px;height:40px;background:#000000"),
  ],
  ["a", "b", "c", "e", "m", "h", "x"],
);

const editCalls = () =>
  native.canvas.editLayers.mock.calls.map(([input]) => (input as CanvasEditLayersInput).edit);
const styleOf = (work: CanvasWork, layerId: string) => {
  const node = work.pages[0]!.frames[0]!.layers.nodes.find((item) => item.id === layerId);
  return node?.type === "element" ? (node.attributes.style ?? "") : "";
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function key(root: HTMLElement, init: KeyboardEventInit) {
  root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

function paste(textValue: string) {
  const data = new DataTransfer();
  data.setData("text/plain", textValue);
  document.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
}

/** A press and release at one viewport-local point, all in one tick. */
function click(root: HTMLElement, target: Element, x: number, y: number) {
  const point = viewportPoint(root, x, y);
  pointer(target, "pointerdown", point.x, point.y);
  pointer(target, "pointerup", point.x, point.y);
}

/** A press, a move by (dx, dy) in a few steps and a release, from a viewport-local point. */
async function drag(
  root: HTMLElement,
  target: Element,
  x: number,
  y: number,
  dx: number,
  dy: number,
  { sync = false }: { sync?: boolean } = {},
) {
  const start = viewportPoint(root, x, y);
  pointer(target, "pointerdown", start.x, start.y);
  for (const step of [0.25, 0.5, 1]) {
    pointer(target, "pointermove", start.x + dx * step, start.y + dy * step);
    if (!sync) await nextFrame();
  }
  pointer(target, "pointerup", start.x + dx, start.y + dy);
}

/** A file drag event on the canvas; what it asked of the browser. */
const dragFiles = (target: HTMLElement, type: string, files: File[]) => {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  // A script-made DataTransfer keeps "none"; record what the canvas asks for instead.
  let effect = "none";
  Object.defineProperty(data, "dropEffect", {
    configurable: true,
    get: () => effect,
    set: (value: string) => {
      effect = value;
    },
  });
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer: data,
    clientX: 300,
    clientY: 200,
  });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, effect: data.dropEffect };
};

/** A key pressed in a field (React sees it; the browser does nothing more). */
const pressKey = (target: Element, value: string) =>
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
  );

describe("canvas editor bugs", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.contextMenu.show.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("B1: clicking away from a text edit commits it once", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root, layer } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "c" }]);
      root.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(layer("c")!.getAttribute("contenteditable")).toBeTruthy());
      await userEvent.keyboard("X");
      click(root, root, 500, 350);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalled());
      await sleep(100);
      expect(editCalls().map((edit) => edit.operations)).toEqual([
        [{ type: "set_text", nodeId: "ct", text: "X" }],
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("B1: text typed into an empty text layer is inserted once", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root, layer } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "e" }]);
      root.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(layer("e")!.getAttribute("contenteditable")).toBeTruthy());
      await userEvent.keyboard("Hi");
      click(root, root, 500, 350);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalled());
      await sleep(100);
      expect(editCalls().map((edit) => edit.operations)).toEqual([
        [{ type: "insert_html", parentId: "e", html: "Hi" }],
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("B2: the Text tool starts editing the text it creates", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root, layer } = await mountCanvas(workOf([f1]));
    try {
      useCanvasEditorStore.getState().setTool("text");
      await nextFrame();
      click(root, root, 300, 250);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(layer("n1")?.getAttribute("contenteditable")).toBe("plaintext-only"),
      );
      expect(useCanvasEditorStore.getState().tool).toBe("move");
    } finally {
      await screen.unmount();
    }
  });

  it("B8: held arrow keys move an absolute layer with a margin by every step", async () => {
    const server = serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "m" }]);
      await nextFrame();
      // Auto-repeat: three presses before any save comes back.
      for (let index = 0; index < 3; index++) key(root, { key: "ArrowRight", code: "ArrowRight" });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(styleOf(server.work, "m")).toContain("left:13px"));
    } finally {
      await screen.unmount();
    }
  });

  it("B9: the layers panel menu acts on the row that was right-clicked", async () => {
    serveCanvas(native, workOf([f1]));
    native.contextMenu.show.mockResolvedValue("delete");
    const { screen } = await mountCanvas(workOf([f1]), { layers: true });
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "a" }]);
      await nextFrame();
      const row = document.querySelector('[data-layer-row="layer:f1:b"]')!;
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 50,
          clientY: 50,
        }),
      );
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalled());
      expect(editCalls()[0]!.operations).toEqual([{ type: "delete", nodeId: "b" }]);
    } finally {
      await screen.unmount();
    }
  });

  it("B10: duplicating does not replace what was copied", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "c", code: "KeyC", ...mod });
      select([{ kind: "layer", frameId: "f1", layerId: "a" }]);
      await nextFrame();
      key(root, { key: "d", code: "KeyD", ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      await nextFrame();
      paste(serializeDesignLayers(f1.layers, false));
      await vi.waitFor(() => expect(native.canvas.restoreFrames).toHaveBeenCalledTimes(1));
      // The paste is the copied frame, not the duplicate: its layers go into the new frame.
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      const pasted = native.canvas.restoreFrames.mock.calls[0]![0].frames[0].id;
      expect(native.canvas.editLayers.mock.calls[1]![0].edit.frameId).toBe(pasted);
    } finally {
      await screen.unmount();
    }
  });

  it("B11: pasting the same frames twice offsets each paste", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "c", code: "KeyC", ...mod });
      const copied = serializeDesignLayers(f1.layers, false);
      paste(copied);
      await vi.waitFor(() => expect(native.canvas.restoreFrames).toHaveBeenCalledTimes(1));
      await nextFrame();
      paste(copied);
      await vi.waitFor(() => expect(native.canvas.restoreFrames).toHaveBeenCalledTimes(2));
      const placed = native.canvas.restoreFrames.mock.calls.map(
        ([input]) => (input as { frames: { x: number; y: number }[] }).frames[0]!,
      );
      expect(placed.map((frame) => [frame.x, frame.y])).toEqual([
        [40, 40],
        [80, 80],
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("B12: a resize released in the same tick as its last move saves that size", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      await vi.waitFor(() => expect(root.querySelector('[data-canvas-handle="se"]')).toBeTruthy());
      await nextFrame();
      const handle = root.querySelector('[data-canvas-handle="se"]')!;
      await drag(root, handle, 400, 300, 50, 30, { sync: true });
      await vi.waitFor(() => expect(native.canvas.layout).toHaveBeenCalledTimes(1));
      expect(native.canvas.layout.mock.calls[0]![0]).toMatchObject({
        frames: [{ id: "f1", x: 0, y: 0, width: 450, height: 330 }],
      });
    } finally {
      await screen.unmount();
    }
  });

  it("B12: a marquee released in the same tick as its last move selects", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      await drag(root, root, 595, 395, -600, -400, { sync: true });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f1"]));
    } finally {
      await screen.unmount();
    }
  });

  it("B13: a frame move the server refuses goes back", async () => {
    const server = serveCanvas(native, workOf([f1]));
    const { screen, root, host } = await mountCanvas(workOf([f1]));
    try {
      server.failCall("layout", 1);
      // A frame with layers drags by its body once it is selected.
      select([{ kind: "frame", frameId: "f1" }]);
      await nextFrame();
      await drag(root, host("f1"), 300, 250, 40, 30);
      await vi.waitFor(() => expect(native.canvas.layout).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(host("f1").parentElement!.style.left).toBe("0px"));
      await sleep(50);
      expect(host("f1").parentElement!.style.left).toBe("0px");
      expect(host("f1").parentElement!.style.top).toBe("0px");
    } finally {
      await screen.unmount();
    }
  });

  it("B13: a layer move the server refuses goes back", async () => {
    const server = serveCanvas(native, workOf([f1]));
    const { screen, root, layer } = await mountCanvas(workOf([f1]));
    try {
      server.failCall("editLayers", 1);
      await drag(root, layer("a")!, 35, 35, 40, 30);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(layer("a")!.style.left).toBe("10px"));
      expect(layer("a")!.style.top).toBe("10px");
    } finally {
      await screen.unmount();
    }
  });

  it("B14: Backspace in the zoom menu does not delete the selection", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "a" }]);
      const trigger = [...root.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("100%"),
      )!;
      await userEvent.click(trigger);
      const item = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>('[role="menuitem"]');
        expect(found).toBeTruthy();
        return found!;
      });
      item.focus();
      await userEvent.keyboard("{Backspace}");
      await sleep(50);
      expect(native.canvas.editLayers).not.toHaveBeenCalled();
      expect(selection()).toEqual(["a"]);
    } finally {
      await screen.unmount();
    }
  });

  it("B15: undo does nothing in a read-only canvas", async () => {
    serveCanvas(native, workOf([f1]));
    const first = await mountCanvas(workOf([f1]));
    await mounted.editor!.run({
      kind: "edit",
      frameId: "f1",
      operations: [{ type: "set_styles", nodeId: "a", styles: { background: "#ff0000" } }],
    });
    await first.screen.unmount();
    const calls = native.canvas.editLayers.mock.calls.length;
    const { screen, root } = await mountCanvas(workOf([f1]), { readOnly: true });
    try {
      root.focus();
      key(root, { key: "z", code: "KeyZ", ...mod });
      await sleep(50);
      expect(native.canvas.editLayers.mock.calls.length).toBe(calls);
    } finally {
      await screen.unmount();
    }
  });

  it("B15: an undo that fails part-way leaves nothing half-undone and can be retried", async () => {
    const server = serveCanvas(native, workOf([f1]));
    const { screen } = await mountCanvas(workOf([f1]));
    try {
      const editor = () => mounted.editor!;
      await editor().batch(async () => {
        for (const layerId of ["a", "b"])
          await editor().run({
            kind: "edit",
            frameId: "f1",
            operations: [
              { type: "set_styles", nodeId: layerId, styles: { background: "#ff0000" } },
            ],
          });
      });
      // Undo reverts b first, then a: the second step is refused.
      server.failCall("editLayers", 2);
      await editor().undo();
      expect(styleOf(server.work, "a")).toContain("background:#ff0000");
      expect(styleOf(server.work, "b")).toContain("background:#ff0000");
      await editor().undo();
      expect(styleOf(server.work, "a")).toContain("background:#0000ff");
      expect(styleOf(server.work, "b")).toContain("background:#00ff00");
    } finally {
      await screen.unmount();
    }
  });

  it("B16: undoing a frame delete brings back its comments and export rows", async () => {
    const thread: CanvasCommentThread = {
      id: "t1",
      frameId: "f1",
      layerId: "a",
      x: 4,
      y: 4,
      status: "open",
      createdAt: "2026-11-10T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
      messages: [
        {
          id: "m1",
          author: { kind: "user" },
          text: "Hi",
          createdAt: "2026-11-10T00:00:00.000Z",
        },
      ],
    };
    const rows = {
      "frame:f1": [{ format: "png" as const, scale: "2x", suffix: "@2x" }],
      "layer:f1:a": [{ format: "png" as const, scale: "1x", suffix: "" }],
    };
    const work = workOf([f1], { comments: [thread], exportSettings: rows });
    const server = serveCanvas(native, work);
    const { screen, root } = await mountCanvas(work);
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "Backspace", code: "Backspace" });
      await vi.waitFor(() => expect(server.work.pages[0]!.frames).toHaveLength(0));
      expect(server.work.pages[0]!.comments).toHaveLength(0);
      await nextFrame();
      await mounted.editor!.undo();
      const page = server.work.pages[0]!;
      expect(page.frames.map((frame) => frame.id)).toEqual(["f1"]);
      expect(page.comments.map((item) => item.id)).toEqual(["t1"]);
      expect(page.exportSettings).toEqual(rows);
    } finally {
      await screen.unmount();
    }
  });

  it("B16: undoing a layer delete brings back its export rows", async () => {
    const rows = { "layer:f1:a": [{ format: "png" as const, scale: "1x", suffix: "" }] };
    const work = workOf([f1], { exportSettings: rows });
    const server = serveCanvas(native, work);
    const { screen, root } = await mountCanvas(work);
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "a" }]);
      root.focus();
      await nextFrame();
      key(root, { key: "Backspace", code: "Backspace" });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      // A later layout write drops the rows of layers that no longer exist.
      await mounted.editor!.run({ kind: "layout", frames: [{ id: "f1", x: 20 }] });
      expect(server.work.pages[0]!.exportSettings).toEqual({});
      await mounted.editor!.undo();
      await mounted.editor!.undo();
      expect(server.work.pages[0]!.exportSettings).toEqual(rows);
    } finally {
      await screen.unmount();
    }
  });

  it("B18: sending several layers to the back keeps their order", async () => {
    const server = serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      // b was selected first, then a.
      select([
        { kind: "layer", frameId: "f1", layerId: "b" },
        { kind: "layer", frameId: "f1", layerId: "a" },
      ]);
      root.focus();
      await nextFrame();
      // a and b are already at the back, in order: nothing moves.
      key(root, { key: "[", code: "BracketLeft" });
      await sleep(100);
      expect(server.frame("f1").layers.roots.slice(0, 2)).toEqual(["a", "b"]);
      key(root, { key: "]", code: "BracketRight" });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      await sleep(50);
      expect(server.frame("f1").layers.roots.slice(-2)).toEqual(["a", "b"]);
    } finally {
      await screen.unmount();
    }
  });

  it("B19: clicking one layer of a multi-selection selects only it", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root, layer } = await mountCanvas(workOf([f1]));
    try {
      select([
        { kind: "layer", frameId: "f1", layerId: "a" },
        { kind: "layer", frameId: "f1", layerId: "b" },
      ]);
      await nextFrame();
      click(root, layer("a")!, 35, 35);
      await vi.waitFor(() => expect(selection()).toEqual(["a"]));
    } finally {
      await screen.unmount();
    }
  });

  it("B20: a layer moves once when its frame is dragged with it", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root, layer } = await mountCanvas(workOf([f1]));
    try {
      select([
        { kind: "frame", frameId: "f1" },
        { kind: "layer", frameId: "f1", layerId: "a" },
      ]);
      await nextFrame();
      await drag(root, layer("a")!, 35, 35, 40, 30);
      await vi.waitFor(() => expect(native.canvas.layout).toHaveBeenCalledTimes(1));
      expect(native.canvas.layout.mock.calls[0]![0]).toMatchObject({
        frames: [{ id: "f1", x: 40, y: 30 }],
      });
      await sleep(50);
      expect(native.canvas.editLayers).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("B20: a fixed-position layer moves freely", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root, layer } = await mountCanvas(workOf([f1]));
    try {
      await drag(root, layer("x")!, 220, 120, 40, 30);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(editCalls()[0]!.operations).toEqual([
        { type: "set_styles", nodeId: "x", styles: { left: "240px", top: "130px" } },
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("B21: a hidden selected layer gets no selection box at the origin", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "a" }]);
      await vi.waitFor(() => expect(root.querySelector("[data-canvas-handle]")).toBeTruthy());
      select([{ kind: "layer", frameId: "f1", layerId: "h" }]);
      await nextFrame();
      await nextFrame();
      expect(root.querySelector("[data-canvas-handle]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("B22: the hand cursor grabs as soon as the pan starts", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      useCanvasEditorStore.getState().setTool("hand");
      await nextFrame();
      expect(getComputedStyle(root).cursor).toBe("grab");
      const point = viewportPoint(root, 500, 350);
      pointer(root, "pointerdown", point.x, point.y);
      await nextFrame();
      expect(getComputedStyle(root).cursor).toBe("grabbing");
      pointer(root, "pointerup", point.x, point.y);
      await nextFrame();
      expect(getComputedStyle(root).cursor).toBe("grab");
    } finally {
      await screen.unmount();
    }
  });

  it("B23: text pasted on empty canvas is one undo step", async () => {
    const server = serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]));
    try {
      root.focus();
      paste("Hello there");
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(server.work.pages[0]!.frames).toHaveLength(2);
      await nextFrame();
      await mounted.editor!.undo();
      expect(server.work.pages[0]!.frames.map((frame) => frame.id)).toEqual(["f1"]);
    } finally {
      await screen.unmount();
    }
  });

  it("B24: select-all, select-others, N and fit all leave hidden and locked frames alone", async () => {
    const shown = frameOf("f3", [], [], { x: 450, y: 0, width: 100, height: 100 });
    const locked = frameOf("lk", [], [], { x: 0, y: 330, width: 100, height: 60, locked: true });
    const hidden = frameOf("hd", [], [], { x: 3000, y: 3000, width: 100, height: 100 });
    const reach = workOf([f1, shown, locked, { ...hidden, hidden: true }]);
    const server = serveCanvas(native, reach);
    const { screen, root } = await mountCanvas(reach);
    try {
      root.focus();
      key(root, { key: "a", code: "KeyA", ...mod });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f1", "frame:f3"]));
      select([{ kind: "frame", frameId: "f1" }]);
      await nextFrame();
      key(root, { key: "A", code: "KeyA", shiftKey: true, ...mod });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f3"]));
      key(root, { key: "n", code: "KeyN" });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f1"]));
      key(root, { key: "N", code: "KeyN", shiftKey: true });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f3"]));
      // ⇧1 fits the frames on the canvas, not the hidden one far away.
      key(root, { key: "!", code: "Digit1", shiftKey: true });
      const fitted = fitDesignCanvas([f1, shown, locked], 600, 400, { maxZoom: 2 });
      await vi.waitFor(() => expect(mounted.editor!.viewport).toEqual(fitted));
      // A locked frame selected anyway (locked while selected) is never deleted…
      select([{ kind: "frame", frameId: "lk" }]);
      await nextFrame();
      key(root, { key: "Backspace", code: "Backspace" });
      await sleep(50);
      expect(native.canvas.layout).not.toHaveBeenCalled();
      // …and ⌘A then ⌫ deletes only the frames within reach.
      key(root, { key: "a", code: "KeyA", ...mod });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f1", "frame:f3"]));
      key(root, { key: "Backspace", code: "Backspace" });
      await vi.waitFor(() =>
        expect(server.work.pages[0]!.frames.map((frame) => frame.id)).toEqual(["lk", "hd"]),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("B25: undoing a change on another page shows that page and brings the change into view", async () => {
    const far = frameOf("g1", [], [], { x: 2000, y: 2000, width: 200, height: 150 });
    const base = workOf([f1]);
    const twoPages: CanvasWork = {
      ...base,
      pages: [
        base.pages[0]!,
        { ...base.pages[0]!, id: "page2", title: "Page 2", frames: [far], comments: [] },
      ],
    };
    const server = serveCanvas(native, twoPages);
    const { screen, root } = await mountCanvas(twoPages, { pages: true });
    try {
      mounted.editor!.selectPage!("page2");
      await vi.waitFor(() => expect(mounted.editor!.page.id).toBe("page2"));
      await mounted.editor!.run({ kind: "layout", frames: [{ id: "g1", x: 2100 }] });
      expect(server.frame("g1", "page2").x).toBe(2100);
      // This page's camera moves away from the frame, then the user goes back to page 1.
      mounted.editor!.setViewport({ x: 0, y: 0, zoom: 1 });
      mounted.editor!.selectPage!("page1");
      await vi.waitFor(() => expect(mounted.editor!.page.id).toBe("page1"));
      await mounted.editor!.undo();
      expect(server.frame("g1", "page2").x).toBe(2000);
      await vi.waitFor(() => expect(mounted.editor!.page.id).toBe("page2"));
      // The frame comes into view at no more than the zoom it had.
      await vi.waitFor(() => {
        const { x, y, zoom } = mounted.editor!.viewport;
        expect(zoom).toBeLessThanOrEqual(1);
        expect(x + 2000 * zoom).toBeGreaterThanOrEqual(0);
        expect(x + 2200 * zoom).toBeLessThanOrEqual(root.clientWidth);
        expect(y + 2000 * zoom).toBeGreaterThanOrEqual(0);
        expect(y + 2150 * zoom).toBeLessThanOrEqual(root.clientHeight);
      });
      // Redo stays on this page; the frame is in view already, so the camera stays.
      const before = mounted.editor!.viewport;
      await mounted.editor!.redo();
      expect(server.frame("g1", "page2").x).toBe(2100);
      await sleep(300);
      expect(mounted.editor!.page.id).toBe("page2");
      expect(mounted.editor!.viewport).toEqual(before);
    } finally {
      await screen.unmount();
    }
  });

  it("B26: only images dragged over an editable canvas are taken; no drop falls through", async () => {
    const image = new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" });
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });
    const editable = await mountCanvas(workOf([f1]));
    try {
      const { root } = editable;
      const place = vi.spyOn(mounted.editor!.commands, "placeImage").mockResolvedValue(undefined);
      // A text file: refused, no highlight, and the browser does not open it.
      dragFiles(root, "dragenter", [notes]);
      expect(dragFiles(root, "dragover", [notes])).toEqual({ prevented: true, effect: "none" });
      expect(root.hasAttribute("data-canvas-file-drop")).toBe(false);
      expect(dragFiles(root, "drop", [notes]).prevented).toBe(true);
      expect(place).not.toHaveBeenCalled();
      // An image: copied, with the drop highlight until it leaves or lands.
      dragFiles(root, "dragenter", [image]);
      expect(root.hasAttribute("data-canvas-file-drop")).toBe(true);
      const highlight = root.querySelector<HTMLElement>("[data-canvas-file-drop-highlight]")!;
      await vi.waitFor(() => expect(getComputedStyle(highlight).opacity).toBe("1"));
      expect(dragFiles(root, "dragover", [image])).toEqual({ prevented: true, effect: "copy" });
      dragFiles(root, "dragleave", [image]);
      expect(root.hasAttribute("data-canvas-file-drop")).toBe(false);
      dragFiles(root, "dragenter", [image]);
      expect(dragFiles(root, "drop", [image]).prevented).toBe(true);
      expect(root.hasAttribute("data-canvas-file-drop")).toBe(false);
      expect(place).toHaveBeenCalledTimes(1);
      expect(place.mock.calls[0]![0]).toBe(image);
    } finally {
      await editable.screen.unmount();
    }
    // An archived work takes nothing, and still keeps the browser from opening the file.
    const archived = await mountCanvas(workOf([f1]), { readOnly: true });
    try {
      const { root } = archived;
      const place = vi.spyOn(mounted.editor!.commands, "placeImage").mockResolvedValue(undefined);
      dragFiles(root, "dragenter", [image]);
      expect(root.hasAttribute("data-canvas-file-drop")).toBe(false);
      expect(dragFiles(root, "dragover", [image])).toEqual({ prevented: true, effect: "none" });
      expect(dragFiles(root, "drop", [image]).prevented).toBe(true);
      expect(place).not.toHaveBeenCalled();
    } finally {
      await archived.screen.unmount();
    }
  });

  it("B27: the Comment tool shows hidden comments and places one; a read-only work takes none", async () => {
    const add = vi.spyOn(toastManager, "add");
    serveCanvas(native, workOf([f1]));
    const editable = await mountCanvas(workOf([f1]));
    try {
      const { root, host } = editable;
      // Choosing the tool shows them.
      useCanvasEditorStore.setState({ commentsHidden: true });
      useCanvasEditorStore.getState().setTool("comment");
      await vi.waitFor(() => expect(useCanvasEditorStore.getState().commentsHidden).toBe(false));
      // Hidden again while the tool is on: the click shows them and opens the composer.
      useCanvasEditorStore.setState({ commentsHidden: true });
      await nextFrame();
      click(root, host("f1"), 200, 150);
      await vi.waitFor(() =>
        expect(root.querySelector('[placeholder="Add a comment"]')).toBeTruthy(),
      );
      expect(useCanvasEditorStore.getState().commentsHidden).toBe(false);
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Comments shown" }));
    } finally {
      await editable.screen.unmount();
    }
    resetCanvasStores();
    const archived = await mountCanvas(workOf([f1]), { readOnly: true });
    try {
      const { root, host } = archived;
      useCanvasEditorStore.getState().setTool("comment");
      await nextFrame();
      click(root, host("f1"), 200, 150);
      await sleep(100);
      expect(root.querySelector('[placeholder="Add a comment"]')).toBeNull();
    } finally {
      await archived.screen.unmount();
    }
  });

  it("B28: a frame label or layer row rename ended with Enter or Escape hands the keyboard back", async () => {
    serveCanvas(native, workOf([f1]));
    const { screen, root } = await mountCanvas(workOf([f1]), { layers: true });
    try {
      // The frame's label, renamed with ⌘R and saved with Enter.
      root.focus();
      select([{ kind: "frame", frameId: "f1" }]);
      await nextFrame();
      key(root, { key: "r", code: "KeyR", ...mod });
      const label = await vi.waitFor(() => {
        const found = root.querySelector<HTMLInputElement>("[data-canvas-frame-label] input");
        expect(found).toBeTruthy();
        return found!;
      });
      expect(document.activeElement).toBe(label);
      label.value = "Home";
      pressKey(label, "Enter");
      await vi.waitFor(() =>
        expect(root.querySelector("[data-canvas-frame-label] input")).toBeNull(),
      );
      expect(document.activeElement).toBe(root);
      await vi.waitFor(() => expect(native.canvas.layout).toHaveBeenCalledTimes(1));
      // A layer row, renamed with ⌘R and left with Escape.
      select([{ kind: "layer", frameId: "f1", layerId: "a" }]);
      await nextFrame();
      key(root, { key: "r", code: "KeyR", ...mod });
      const row = await vi.waitFor(() => {
        const found = document.querySelector<HTMLInputElement>(
          '[data-layer-row="layer:f1:a"] input',
        );
        expect(found).toBeTruthy();
        return found!;
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(row));
      pressKey(row, "Escape");
      await vi.waitFor(() =>
        expect(document.querySelector('[data-layer-row="layer:f1:a"] input')).toBeNull(),
      );
      expect(document.activeElement).toBe(root);
    } finally {
      await screen.unmount();
    }
  });

  it("B29: closing a comment card hands the keyboard back to the canvas", async () => {
    const thread: CanvasCommentThread = {
      id: "t1",
      frameId: "f1",
      layerId: null,
      x: 200,
      y: 150,
      status: "open",
      createdAt: "2026-11-10T00:00:01.000Z",
      updatedAt: "2026-11-10T00:00:01.000Z",
      messages: [
        { id: "m1", author: { kind: "user" }, text: "Hi", createdAt: "2026-11-10T00:00:01.000Z" },
      ],
    };
    const commented = workOf([f1], { comments: [thread] });
    serveCanvas(native, commented);
    const { screen, root } = await mountCanvas(commented);
    try {
      mounted.editor!.openComment({ threadId: "t1" });
      const reply = await vi.waitFor(() => {
        const found = root.querySelector<HTMLTextAreaElement>('[placeholder="Reply"]');
        expect(found).toBeTruthy();
        return found!;
      });
      reply.focus();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(root.querySelector('[placeholder="Reply"]')).toBeNull());
      expect(document.activeElement).toBe(root);
      // Single-key shortcuts work again: C picks the Comment tool.
      key(root, { key: "c", code: "KeyC" });
      await vi.waitFor(() => expect(useCanvasEditorStore.getState().tool).toBe("comment"));
    } finally {
      await screen.unmount();
    }
  });
});

/** Two editors on one work, like the side pane and a second window. */
const twoEditors: (CanvasEditorApi | undefined)[] = [];
function Capture({ index }: { index: number }) {
  twoEditors[index] = useCanvasEditor();
  return null;
}
function TwoEditors() {
  const { data } = useQuery({ ...canvasWorkQueryOptions("work1"), enabled: false });
  if (!data) return null;
  return (
    <>
      {[0, 1].map((index) => (
        <CanvasEditorProvider key={index} work={data} pageId="page1" readOnly={false}>
          <Capture index={index} />
        </CanvasEditorProvider>
      ))}
    </>
  );
}

const restyle = (editor: CanvasEditorApi, layerId: string) =>
  editor.run({
    kind: "edit",
    frameId: "f1",
    operations: [{ type: "set_styles", nodeId: layerId, styles: { background: "#123456" } }],
  });

describe("canvas undo groups (B17)", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });

  it("keeps another editor's change out of an open undo group", async () => {
    const work = workOf([f1]);
    const server = serveCanvas(native, work);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(canvasWorkQueryKey("work1"), work);
    twoEditors.length = 0;
    const screen = await render(
      <QueryClientProvider client={client}>
        <SidebarProvider>
          <TwoEditors />
        </SidebarProvider>
      </QueryClientProvider>,
    );
    try {
      await vi.waitFor(() => expect(twoEditors.filter(Boolean)).toHaveLength(2));
      const editors = twoEditors as CanvasEditorApi[];
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const grouped = editors[0]!.batch(async () => {
        await restyle(editors[0]!, "a");
        await gate;
        await restyle(editors[0]!, "b");
      });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      await restyle(editors[1]!, "m");
      open();
      await grouped;
      // The newest step is the first editor's group; the other editor's change is its own step.
      await editors[1]!.undo();
      expect(styleOf(server.work, "a")).toContain("background:#0000ff");
      expect(styleOf(server.work, "b")).toContain("background:#00ff00");
      expect(styleOf(server.work, "m")).toContain("background:#123456");
      await editors[1]!.undo();
      expect(styleOf(server.work, "m")).toContain("background:#ff0000");
    } finally {
      await screen.unmount();
    }
  });
});
