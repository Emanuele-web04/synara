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

import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "vitest-browser-react";
import { CanvasPagesSection } from "../CanvasPagesSection";
import { useCanvasActivityStore, useCanvasEditorStore } from "../canvasStores";
import { canvasWorkQueryKey } from "../canvasWorkCache";
import { flushCanvasCameras } from "./canvasCamera";
import { canvasClipboardHtml } from "./canvasClipboard";
import {
  at,
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

const f1 = frameOf(
  "f1",
  [
    element(
      "card",
      "position:absolute;left:20px;top:20px;width:200px;height:100px;display:flex;gap:10px",
      ["one", "two"],
    ),
    element("one", "width:60px;height:40px", ["oneText"], "button"),
    text("oneText", "One"),
    element("two", "width:60px;height:40px", ["twoText"], "button"),
    text("twoText", "Two"),
    element("badge", "position:absolute;left:250px;top:20px;width:40px;height:40px"),
    element("note", "position:absolute;left:20px;top:200px;font-size:16px", ["noteText"], "p"),
    text("noteText", "Note"),
  ],
  ["card", "badge", "note"],
);
const f2 = frameOf("f2", [], [], { x: 450, y: 0, width: 100, height: 100 });
const work = () => workOf([f1, f2]);
const lastEdit = () => native.canvas.editLayers.mock.calls.at(-1)![0].edit;

describe("canvas shortcuts", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("⌘⌫ ungroups, ⇧F frames the selection, ⌥⇧A removes flex, ⌥C clips", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([{ kind: "layer", frameId: "f1", layerId: "card" }]);
      await nextFrame();
      key(root, { key: "Á", code: "KeyA", altKey: true, shiftKey: true });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(lastEdit().operations[0]).toMatchObject({
        type: "set_styles",
        nodeId: "card",
        styles: { display: null, gap: null },
      });
      key(root, { key: "ç", code: "KeyC", altKey: true });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(lastEdit().operations[0]).toMatchObject({ styles: { overflow: "hidden" } });
      key(root, { key: "Backspace", code: "Backspace", ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(3));
      expect(lastEdit().operations.map((operation: { type: string }) => operation.type)).toEqual([
        "move",
        "move",
        "delete",
      ]);
      await vi.waitFor(() => expect(selection()).toEqual(["one", "two"]));
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      key(root, { key: "F", code: "KeyF", shiftKey: true });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(5));
      expect(native.canvas.editLayers.mock.calls[3]![0].edit.operations[0]).toMatchObject({
        type: "insert_html",
        html: '<div style=""></div>',
      });
      expect(useCanvasEditorStore.getState().tool).toBe("move");
    } finally {
      await screen.unmount();
    }
  });

  it("digits set opacity with a selection (two quick digits exact) and zoom without one", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      key(root, { key: "5", code: "Digit5" });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(lastEdit().operations[0].styles).toEqual({ opacity: "0.5" });
      await sleep(650);
      key(root, { key: "4", code: "Digit4" });
      key(root, { key: "5", code: "Digit5" });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(3));
      expect(lastEdit().operations[0].styles).toEqual({ opacity: "0.45" });
      select([]);
      mounted.editor!.setViewport({ x: 0, y: 0, zoom: 0.5 });
      await nextFrame();
      key(root, { key: "0", code: "Digit0" });
      await vi.waitFor(() => expect(mounted.editor!.viewport.zoom).toBe(1));
    } finally {
      await screen.unmount();
    }
  });

  it("selects the others, steps frames with N, toggles comments and the UI", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      key(root, { key: "A", code: "KeyA", shiftKey: true, ...mod });
      await vi.waitFor(() => expect(selection()).toEqual(["card", "note"]));
      key(root, { key: "n", code: "KeyN" });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f2"]));
      key(root, { key: "N", code: "KeyN", shiftKey: true });
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f1"]));
      key(root, { key: "C", code: "KeyC", shiftKey: true });
      expect(useCanvasEditorStore.getState().commentsHidden).toBe(true);
      // `.` hides the panels and tools (the strip and inspector live beside the canvas); the
      // canvas's own corner zoom goes with them.
      expect(root.querySelector("[data-canvas-zoom-corner]")).toBeTruthy();
      key(root, { key: ".", code: "Period" });
      await vi.waitFor(() => expect(useCanvasEditorStore.getState().uiHidden).toBe(true));
      expect(root.querySelector("[data-canvas-zoom-corner]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("aligns and steps text with the text keys", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([{ kind: "layer", frameId: "f1", layerId: "note" }]);
      await nextFrame();
      key(root, { key: "†", code: "KeyT", altKey: true, ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(lastEdit().operations[0]).toMatchObject({
        nodeId: "note",
        styles: { "text-align": "center" },
      });
      key(root, { key: ">", code: "Period", shiftKey: true, ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(lastEdit().operations[0].styles).toEqual({ "font-size": "17px" });
      // A frame applies typography keys to every text layer inside it.
      select([{ kind: "frame", frameId: "f1" }]);
      await nextFrame();
      key(root, { key: "†", code: "KeyT", altKey: true, ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(3));
      expect(
        lastEdit()
          .operations.map((operation: { nodeId: string }) => operation.nodeId)
          .toSorted(),
      ).toEqual(["note", "one", "two"]);
    } finally {
      await screen.unmount();
    }
  });
});

const pasteEvent = (flavours: Record<string, string>) => {
  const data = new DataTransfer();
  for (const [type, value] of Object.entries(flavours)) data.setData(type, value);
  document.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
};

describe("canvas clipboard", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("writes the tree into the HTML flavour and pastes it in another window, sanitized", async () => {
    const write = vi.fn(async () => {});
    vi.spyOn(navigator.clipboard, "write").mockImplementation(write);
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      key(root, { key: "c", code: "KeyC", ...mod });
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      const item = (write.mock.calls[0] as unknown as [ClipboardItem[]])[0][0]!;
      const html = await (await item.getType("text/html")).text();
      expect(html).toContain("<!--synara-canvas:v1:");
      // Another window: the plain text differs from this window's last copy.
      select([{ kind: "frame", frameId: "f2" }]);
      await nextFrame();
      pasteEvent({ "text/html": html, "text/plain": "from elsewhere" });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(lastEdit()).toMatchObject({
        frameId: "f2",
        operations: [{ type: "insert_html", parentId: null }],
      });
      expect(lastEdit().operations[0].html).toContain("left:250px");
    } finally {
      await screen.unmount();
    }
  });

  it("pastes on top of the selection and in its place, from the clipboard", async () => {
    const html = canvasClipboardHtml(
      {
        frames: [],
        layers: [
          {
            roots: ["x"],
            nodes: [element("x", "position:absolute;left:0px;top:0px;width:10px;height:10px")],
          },
        ],
      },
      "",
    );
    vi.spyOn(navigator.clipboard, "read").mockImplementation(async () => [
      new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) }),
    ]);
    const server = serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      key(root, { key: "V", code: "KeyV", shiftKey: true, ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      // On top: right after the badge in paint order, at the badge's position.
      expect(lastEdit().operations).toEqual([
        {
          type: "insert_html",
          parentId: null,
          beforeId: "note",
          html: expect.stringContaining("left:250px;top:20px"),
        },
      ]);
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await nextFrame();
      key(root, { key: "R", code: "KeyR", shiftKey: true, ...mod });
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(lastEdit().operations.map((operation: { type: string }) => operation.type)).toEqual([
        "insert_html",
        "delete",
      ]);
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.some((node) => node.id === "badge")).toBe(false),
      );
      // One undo step brings the badge back.
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.some((node) => node.id === "badge")).toBe(true),
      );
    } finally {
      await screen.unmount();
    }
  });
});

const row = (key: string) =>
  document.querySelector<HTMLElement>(`[data-layer-row="${CSS.escape(key)}"]`);

describe("layers panel", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  /** An HTML drag from one row to a point on another (the same point twice: moving slowly). */
  const dragRow = async (from: string, to: string, ratio: number, dx = 30) => {
    const source = row(from)!;
    const data = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    await nextFrame();
    const target = row(to)!;
    const box = target.getBoundingClientRect();
    const point = { clientX: box.left + dx, clientY: box.top + box.height * ratio };
    for (let at = 0; at < 3; at++) {
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          ...point,
        }),
      );
      await nextFrame();
    }
    return () => {
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, ...point }),
      );
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));
    };
  };

  it("indents 16 px a level and nests a slowly dropped row inside a container", async () => {
    const server = serveCanvas(native, work());
    const { screen } = await mountCanvas(work(), { layers: true });
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      await vi.waitFor(() => expect(row("layer:f1:one")).toBeTruthy());
      // The row lanes: the chevron in the indent, 16 px more per level.
      expect(row("layer:f1:card")!.style.paddingInlineStart).toBe("20px");
      expect(row("layer:f1:one")!.style.paddingInlineStart).toBe("36px");
      const finish = await dragRow("layer:f1:badge", "layer:f1:card", 0.5);
      await nextFrame();
      expect(row("layer:f1:card")!.className).toContain("ring-1");
      finish();
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(lastEdit().operations).toEqual([{ type: "move", nodeId: "badge", parentId: "card" }]);
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.nodes.find((node) => node.id === "card")).toMatchObject({
          children: ["one", "two", "badge"],
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("moves several rows to another frame in one undo step", async () => {
    const server = serveCanvas(native, work());
    const { screen } = await mountCanvas(work(), { layers: true });
    try {
      select([
        { kind: "layer", frameId: "f1", layerId: "badge" },
        { kind: "layer", frameId: "f1", layerId: "note" },
      ]);
      await vi.waitFor(() => expect(row("layer:f1:badge")).toBeTruthy());
      (await dragRow("layer:f1:badge", "frame:f2", 0.5))();
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(native.canvas.editLayers.mock.calls[0]![0].edit).toMatchObject({
        frameId: "f2",
        operations: [
          { type: "insert_layers", parentId: null, layers: { roots: ["badge"] } },
          { type: "insert_layers", parentId: null, layers: { roots: ["note"] } },
        ],
      });
      expect(native.canvas.editLayers.mock.calls[1]![0].edit).toMatchObject({
        frameId: "f1",
        operations: [
          { type: "delete", nodeId: "badge" },
          { type: "delete", nodeId: "note" },
        ],
      });
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(server.frame("f1").layers.roots).toEqual(["card", "badge", "note"]),
      );
      expect(server.frame("f2").layers.roots).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });

  it("hides, locks, renames and reorders frames; dims hidden children and dots inherited locks", async () => {
    const server = serveCanvas(native, work());
    const { screen, host } = await mountCanvas(work(), { layers: true });
    try {
      select([{ kind: "layer", frameId: "f1", layerId: "one" }]);
      await vi.waitFor(() => expect(row("layer:f1:one")).toBeTruthy());
      const button = (key: string, label: string) =>
        row(key)!.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      button("layer:f1:card", "Lock").click();
      await vi.waitFor(() =>
        expect(row("layer:f1:one")!.querySelector("[data-inherited-lock]")).toBeTruthy(),
      );
      button("layer:f1:card", "Hide").click();
      await vi.waitFor(() =>
        expect(row("layer:f1:one")!.querySelector("[data-tree-row-label]")!.className).toContain(
          "opacity-40",
        ),
      );
      button("frame:f2", "Hide").click();
      await vi.waitFor(() => expect(host("f2")).toBeNull());
      expect(server.frame("f2").hidden).toBe(true);
      button("frame:f2", "Lock").click();
      await vi.waitFor(() => expect(server.frame("f2").locked).toBe(true));
      // A frame row renames inline.
      row("frame:f1")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const input = await vi.waitFor(() => {
        const found = row("frame:f1")!.querySelector("input");
        expect(found).toBeTruthy();
        return found!;
      });
      input.value = "Home";
      input.blur();
      await vi.waitFor(() => expect(server.frame("f1").title).toBe("Home"));
      // f2 (listed first, in front) dropped below f1 goes behind it.
      (await dragRow("frame:f2", "frame:f1", 0.9))();
      await vi.waitFor(() =>
        expect(server.work.pages[0]!.frames.map((frame) => frame.id)).toEqual(["f2", "f1"]),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("renames with ⌘R, collapses everything with ⌥L and centres the camera from the icon", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work(), { layers: true });
    try {
      root.focus();
      select([{ kind: "layer", frameId: "f1", layerId: "badge" }]);
      await vi.waitFor(() => expect(row("layer:f1:badge")).toBeTruthy());
      key(root, { key: "r", code: "KeyR", ...mod });
      await vi.waitFor(() => expect(row("layer:f1:badge")!.querySelector("input")).toBeTruthy());
      row("layer:f1:badge")!
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await nextFrame();
      root.focus();
      key(root, { key: "¬", code: "KeyL", altKey: true });
      await vi.waitFor(() => expect(row("layer:f1:badge")).toBeNull());
      // The icon of the f1 row: f1 (400×300) comes to the middle of the 600×400 canvas.
      row("frame:f1")!
        .querySelector("[data-tree-row-icon]")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await vi.waitFor(() => expect(mounted.editor!.viewport).toEqual({ x: 100, y: 50, zoom: 1 }));
      expect(row("frame:f1")!.querySelector("input")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

describe("comments tool, agent activity, camera and live inspector", () => {
  beforeEach(() => {
    resetCanvasStores();
    useCanvasActivityStore.setState({ frames: {}, layers: {} });
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("closes an open thread with the first click and opens the composer on pointer up", async () => {
    const thread = {
      id: "t1",
      frameId: "f1",
      layerId: null,
      x: 300,
      y: 250,
      status: "open" as const,
      createdAt: at(1),
      updatedAt: at(1),
      messages: [{ id: "m1", author: { kind: "user" as const }, text: "Hi", createdAt: at(1) }],
    };
    const commented = workOf([f1, f2], { comments: [thread] });
    serveCanvas(native, commented);
    const { screen, root, host } = await mountCanvas(commented);
    try {
      useCanvasEditorStore.getState().setTool("comment");
      mounted.editor!.openComment({ threadId: "t1" });
      await nextFrame();
      expect(mounted.editor!.activeCommentId).toBe("t1");
      const point = viewportPoint(root, 100, 250);
      pointer(host("f1"), "pointerdown", point.x, point.y);
      pointer(host("f1"), "pointerup", point.x, point.y);
      await vi.waitFor(() => expect(mounted.editor!.activeCommentId).toBeNull());
      expect(root.querySelector('[placeholder="Add a comment"]')).toBeNull();
      pointer(host("f1"), "pointerdown", point.x, point.y);
      await nextFrame();
      expect(root.querySelector('[placeholder="Add a comment"]')).toBeNull();
      pointer(host("f1"), "pointerup", point.x, point.y);
      await vi.waitFor(() =>
        expect(root.querySelector('[placeholder="Add a comment"]')).toBeTruthy(),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("outlines an agent's frame with its radius, rains in the label and flashes layer reveals", async () => {
    const rounded = { ...f1, style: "background:#fff;border-radius:16px" };
    serveCanvas(native, workOf([rounded, f2]));
    const { screen, root } = await mountCanvas(workOf([rounded, f2]), { layers: true });
    try {
      await nextFrame();
      const event = (kind: "read" | "edit", layerIds?: Record<string, string[]>) =>
        useCanvasActivityStore.getState().record({
          type: "activity",
          workId: "work1",
          pageId: "page1",
          frameIds: ["f1"],
          threadId: "chat1" as never,
          expiresAt: new Date(Date.now() + 40_000).toISOString(),
          kind,
          ...(layerIds ? { layerIds } : {}),
        });
      event("edit", { f1: ["badge"] });
      const outline = await vi.waitFor(() => {
        const found = root.querySelector<HTMLElement>('[data-canvas-agent-outline="f1"]');
        expect(found).toBeTruthy();
        return found!;
      });
      expect((outline.firstElementChild as HTMLElement).style.borderRadius).toContain("16px");
      await vi.waitFor(() => expect(outline.style.opacity).toBe("1"));
      expect(
        root.querySelector('[data-canvas-frame-label="f1"] [data-canvas-agent-rain]'),
      ).toBeTruthy();
      // The frame's row in the layers panel shows the same indicator in place of its icon;
      // the other frame keeps its icon.
      await vi.waitFor(() =>
        expect(row("frame:f1")?.querySelector("[data-canvas-page-activity]")).toBeTruthy(),
      );
      expect(row("frame:f2")?.querySelector("[data-canvas-page-activity]")).toBeNull();
      // The edit flashes over the badge, inside the frame.
      await vi.waitFor(() =>
        expect(root.querySelector('[data-canvas-reveal="edit"]')).toBeTruthy(),
      );
      // The turn ends: both fade out over 400 ms, then go.
      useCanvasActivityStore.getState().record({
        type: "activity",
        workId: "work1",
        pageId: "page1",
        frameIds: [],
        threadId: "chat1" as never,
        expiresAt: new Date().toISOString(),
        ended: true,
      });
      await vi.waitFor(() => expect(outline.style.opacity).toBe("0"));
      await vi.waitFor(() =>
        expect(root.querySelector('[data-canvas-agent-outline="f1"]')).toBeNull(),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("flashes where a deleted layer was and shows the rain in the pages list", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, client } = await mountCanvas(work());
    try {
      await nextFrame();
      // The agent deletes the badge: the change lands first, then the activity names it.
      const next = {
        ...server.work,
        updatedAt: at(9),
        pages: server.work.pages.map((page) => ({
          ...page,
          frames: page.frames.map((frame) =>
            frame.id === "f1"
              ? {
                  ...frame,
                  revision: frame.revision + 1,
                  layers: {
                    roots: frame.layers.roots.filter((id) => id !== "badge"),
                    nodes: frame.layers.nodes.filter((node) => node.id !== "badge"),
                  },
                }
              : frame,
          ),
        })),
      };
      client.setQueryData(canvasWorkQueryKey("work1"), next);
      await vi.waitFor(() =>
        expect(root.querySelector('[data-synara-layer-id="badge"]')).toBeNull(),
      );
      useCanvasActivityStore.getState().record({
        type: "activity",
        workId: "work1",
        pageId: "page1",
        frameIds: ["f1"],
        threadId: "chat1" as never,
        expiresAt: new Date(Date.now() + 40_000).toISOString(),
        kind: "delete",
        layerIds: { f1: ["badge"] },
      });
      const flash = await vi.waitFor(() => {
        const found = root.querySelector<HTMLElement>('[data-canvas-reveal="delete"]');
        expect(found).toBeTruthy();
        return found!;
      });
      const box = flash.getBoundingClientRect();
      const origin = root.getBoundingClientRect();
      expect([Math.round(box.left - origin.left), Math.round(box.width)]).toEqual([250, 40]);
      const list = await render(
        <QueryClientProvider client={client}>
          <CanvasPagesSection work={server.work} pageId="page1" onSelect={() => {}} />
        </QueryClientProvider>,
      );
      await vi.waitFor(() =>
        expect(document.querySelector("[data-canvas-page-activity]")).toBeTruthy(),
      );
      await list.unmount();
    } finally {
      await screen.unmount();
    }
  });

  it("animates zoom commands without rendering, and tells a pinch from a held Ctrl", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      await nextFrame();
      mounted.commits = 0;
      key(root, { key: "=", code: "Equal", ...mod });
      await nextFrame();
      // Mid-animation: the world moves, nothing renders, nothing is saved yet.
      const world = root.firstElementChild as HTMLElement;
      expect(world.style.transform).not.toBe("translate(0px, 0px) scale(1)");
      expect(mounted.commits).toBe(0);
      expect(mounted.editor!.viewport.zoom).toBe(1);
      await vi.waitFor(() => expect(mounted.editor!.viewport.zoom).toBeCloseTo(1.25, 5));
      mounted.editor!.setViewport({ x: 0, y: 0, zoom: 1 });
      await nextFrame();
      const wheel = (init: WheelEventInit) =>
        root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
      const zoom = () => mounted.editor!.camera.get().zoom;
      // A pinch (ctrlKey without the key held) zooms 0.01 per pixel of delta…
      let before = zoom();
      wheel({ deltaY: -10, ctrlKey: true });
      expect(zoom() / before).toBeCloseTo(Math.exp(0.1), 5);
      // …a mouse wheel with Ctrl held 0.002, so one 100px notch is a step, not a jump.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
      before = zoom();
      wheel({ deltaY: -100, ctrlKey: true });
      expect(zoom() / before).toBeCloseTo(Math.exp(0.2), 5);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    } finally {
      await screen.unmount();
    }
  });

  it("ends a pan when the window loses focus, keeping where it got to", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      useCanvasEditorStore.getState().setTool("hand");
      await nextFrame();
      const start = viewportPoint(root, 500, 300);
      pointer(root, "pointerdown", start.x, start.y);
      pointer(root, "pointermove", start.x + 30, start.y + 10);
      await nextFrame();
      window.dispatchEvent(new Event("blur"));
      await vi.waitFor(() => expect(mounted.editor!.viewport).toEqual({ x: 30, y: 10, zoom: 1 }));
      expect(root.hasAttribute("data-canvas-gesture")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("updates the inspector's X and W while the canvas drags and resizes, without rendering the canvas", async () => {
    serveCanvas(native, work());
    const { screen, root, host } = await mountCanvas(work(), { inspector: true });
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      const x = await vi.waitFor(() => {
        const found = document.querySelector<HTMLInputElement>('input[aria-label="X position"]');
        expect(found?.value).toBe("0");
        return found!;
      });
      await nextFrame();
      const start = viewportPoint(root, 350, 250);
      pointer(host("f1"), "pointerdown", start.x, start.y);
      await nextFrame();
      mounted.commits = 0;
      pointer(host("f1"), "pointermove", start.x + 20, start.y);
      await nextFrame();
      pointer(host("f1"), "pointermove", start.x + 35, start.y);
      await nextFrame();
      expect(x.value).toBe("35");
      expect(mounted.commits).toBe(0);
      pointer(host("f1"), "pointerup", start.x + 35, start.y);
      await vi.waitFor(() => expect(native.canvas.layout).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(x.value).toBe("35"));
    } finally {
      await screen.unmount();
    }
  });
});
