import "../../../index.css";

import type { CanvasChangedEvent, DesignFrame } from "@synara/contracts";
import { designTextRuns } from "@synara/shared/designCanvasText";
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

import { handleCanvasChanged } from "../canvasWorkCache";
import { flushCanvasCameras } from "./canvasCamera";
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
const modKey = isMac ? "Meta" : "Control";
const chord = (key: string) => `{${modKey}>}${key}{/${modKey}}`;
const mod = { metaKey: isMac, ctrlKey: !isMac };

// "Hello world" as plain text, "Build faster today" with "faster" bold, and a box beside them.
const f1 = frameOf(
  "f1",
  [
    element(
      "plain",
      "position:absolute;left:20px;top:20px;margin:0;width:340px;font-size:20px;line-height:24px",
      ["plainText"],
      "p",
    ),
    text("plainText", "Hello world"),
    element(
      "rich",
      "position:absolute;left:20px;top:80px;margin:0;width:340px;font-size:20px;line-height:24px",
      ["r1", "rs", "r2"],
      "p",
    ),
    text("r1", "Build "),
    element("rs", "font-weight:700", ["rst"], "span"),
    text("rst", "faster"),
    text("r2", " today"),
    element(
      "box",
      "position:absolute;left:20px;top:160px;width:60px;height:40px;background:#00ff00",
    ),
  ],
  ["plain", "rich", "box"],
);
const work = () => workOf([f1]);

const storedRuns = (frame: DesignFrame, id: string) =>
  designTextRuns(new Map(frame.layers.nodes.map((node) => [node.id, node])), id).map(
    ({ text: value, style }) => ({ text: value, style }),
  );
const operationsOf = (call: number) =>
  native.canvas.editLayers.mock.calls[call]![0].edit.operations;

/** Starts editing a text layer from the keyboard (Enter on the selected layer). */
async function edit(root: HTMLElement, layer: (id: string) => HTMLElement | null, id: string) {
  select([{ kind: "layer", frameId: "f1", layerId: id }]);
  root.focus();
  await nextFrame();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(layer(id)!.isContentEditable).toBe(true));
  return layer(id)!;
}

/** Selects characters [start, end) of an element, through its text nodes. */
function selectText(target: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  const find = (offset: number, preferEnd: boolean) => {
    let at = 0;
    for (const node of texts) {
      const inside = preferEnd
        ? offset > at && offset <= at + node.length
        : offset >= at && offset < at + node.length;
      if (inside) return { node, offset: offset - at };
      at += node.length;
    }
    const last = texts.at(-1)!;
    return { node: last, offset: last.length };
  };
  const from = find(start, start === end);
  const to = start === end ? from : find(end, true);
  document.getSelection()!.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
}

const shadowSelection = (host: HTMLElement) =>
  (host.shadowRoot as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ??
  document.getSelection();

function click(root: HTMLElement, target: Element, x: number, y: number, init = {}) {
  const point = viewportPoint(root, x, y);
  pointer(target, "pointerdown", point.x, point.y, init);
  pointer(target, "pointerup", point.x, point.y, init);
}

describe("rich text: styled ranges in a text block", () => {
  beforeEach(async () => {
    await page.viewport(1200, 900);
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.canvas.fontCatalog.mockResolvedValue({ families: [], available: true });
    native.canvas.getAsset.mockRejectedValue(new Error("no assets in this test"));
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("bolds a selected word as one span and one undo step; undo inside and after the edit", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      let block = await edit(root, layer, "plain");
      selectText(block, 6, 11);
      await userEvent.keyboard(chord("b"));
      const span = block.querySelector("span")!;
      expect(span.textContent).toBe("world");
      expect(getComputedStyle(span).fontWeight).toBe("700");
      // ⌘Z inside the edit takes the bold back; nothing was saved.
      await userEvent.keyboard(chord("z"));
      expect(block.querySelector("span")).toBeNull();
      expect(block.textContent).toBe("Hello world");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(mounted.editor!.editingText).toBeNull());
      expect(native.canvas.editLayers).not.toHaveBeenCalled();

      block = await edit(root, layer, "plain");
      selectText(block, 6, 11);
      await userEvent.keyboard(chord("b"));
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(operationsOf(0)).toEqual([
        { type: "set_text", nodeId: "plainText", text: "Hello " },
        {
          type: "insert_layers",
          parentId: "plain",
          layers: {
            roots: [expect.stringMatching(/^layer_/)],
            nodes: [
              expect.objectContaining({
                type: "element",
                tag: "span",
                attributes: { style: "font-weight:700" },
              }),
              expect.objectContaining({ type: "text", text: "world" }),
            ],
          },
        },
      ]);
      expect(storedRuns(server.frame("f1"), "plain")).toEqual([
        { text: "Hello ", style: "" },
        { text: "world", style: "font-weight:700" },
      ]);
      // Rendered as one text layer: the range is a span without a layer ID of its own.
      await vi.waitFor(() =>
        expect(layer("plain")!.querySelector("span")?.textContent).toBe("world"),
      );
      expect(layer("plain")!.querySelector("[data-synara-layer-id]")).toBeNull();
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(storedRuns(server.frame("f1"), "plain")).toEqual([
          { text: "Hello world", style: "" },
        ]),
      );
      await vi.waitFor(() => expect(layer("plain")!.querySelector("span")).toBeNull());
    } finally {
      await screen.unmount();
    }
  });

  it("toggles bold off a whole range and merges it back into plain text, no span left", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      const block = await edit(root, layer, "rich");
      selectText(block, 6, 12);
      await userEvent.keyboard(chord("b"));
      expect(block.querySelector("span")).toBeNull();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(operationsOf(0)).toEqual([
        { type: "delete", nodeId: "rs" },
        { type: "delete", nodeId: "r2" },
        { type: "set_text", nodeId: "r1", text: "Build faster today" },
      ]);
      const stored = server.frame("f1").layers.nodes;
      expect(stored.find((node) => node.id === "rich")).toMatchObject({ children: ["r1"] });
      expect(stored.some((node) => node.id === "rs" || node.id === "rst")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("overlaps bold and italic ranges into three runs, saved as one edit", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      const block = await edit(root, layer, "plain");
      selectText(block, 0, 8);
      await userEvent.keyboard(chord("b"));
      selectText(block, 6, 11);
      await userEvent.keyboard(chord("i"));
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(storedRuns(server.frame("f1"), "plain")).toEqual([
        { text: "Hello ", style: "font-weight:700" },
        { text: "wo", style: "font-weight:700;font-style:italic" },
        { text: "rld", style: "font-style:italic" },
      ]);
      // ⌘U with only a caret underlines the whole block, and that is one step too.
      const again = await edit(root, layer, "plain");
      selectText(again, 3, 3);
      await userEvent.keyboard(chord("u"));
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(operationsOf(1)).toEqual([
        { type: "set_styles", nodeId: "plain", styles: { "text-decoration-line": "underline" } },
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("styles the selected range from the inspector, which shows mixed values, in one step", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work(), { inspector: true });
    try {
      const block = await edit(root, layer, "rich");
      // "ld fas": plain and bold characters, so the style reads as mixed.
      selectText(block, 3, 9);
      const style = page.getByRole("combobox", { name: "Style", exact: true });
      await vi.waitFor(() => expect(style.element().textContent).toContain("–"));
      // A caret reads the block again.
      selectText(block, 1, 1);
      await vi.waitFor(() => expect(style.element().textContent).not.toContain("–"));
      selectText(block, 3, 9);
      await vi.waitFor(() => expect(style.element().textContent).toContain("–"));
      const color = page.getByRole("textbox", { name: "Text color", exact: true });
      await color.fill("#ff0000");
      color
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      // The edit stays open while the inspector has focus; the range shows the colour now.
      await vi.waitFor(() =>
        expect([...block.querySelectorAll("span")].map((span) => span.style.color)).toEqual([
          "rgb(255, 0, 0)",
          "rgb(255, 0, 0)",
          "",
        ]),
      );
      expect(mounted.editor!.editingText?.layerId).toBe("rich");
      expect(native.canvas.editLayers).not.toHaveBeenCalled();
      // A click on empty canvas ends the edit and saves typing and styling together.
      click(root, root, 500, 350);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(storedRuns(server.frame("f1"), "rich")).toEqual([
        { text: "Bui", style: "" },
        { text: "ld ", style: "color:#FF0000" },
        { text: "fas", style: "font-weight:700;color:#FF0000" },
        { text: "ter", style: "font-weight:700" },
        { text: " today", style: "" },
      ]);
      // The span the edit only restyled kept its layer ID.
      expect(operationsOf(0)).toContainEqual({
        type: "set_attributes",
        nodeId: "rs",
        attributes: { style: "font-weight:700;color:#FF0000" },
      });
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(storedRuns(server.frame("f1"), "rich")).toEqual([
          { text: "Build ", style: "" },
          { text: "faster", style: "font-weight:700" },
          { text: " today", style: "" },
        ]),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the style while typing inside a range, and pastes plain text only", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      const block = await edit(root, layer, "rich");
      selectText(block, 9, 9);
      await userEvent.keyboard("XY");
      expect(block.querySelector("span")!.textContent).toBe("fasXYter");
      // Foreign markup on the clipboard: only its plain text goes in, here inside the range.
      const data = new DataTransfer();
      data.setData("text/html", '<b style="color:red">Bold</b><img src="x">');
      data.setData("text/plain", "!");
      block.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
      expect(block.querySelector("b, img")).toBeNull();
      expect(block.querySelector("span")!.textContent).toBe("fasXY!ter");
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(operationsOf(0)).toEqual([{ type: "set_text", nodeId: "rst", text: "fasXY!ter" }]);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the caret and the spans of an open edit while an agent restyles a sibling", async () => {
    const server = serveCanvas(native, work());
    const { screen, root, layer, host, client } = await mountCanvas(work());
    try {
      const block = await edit(root, layer, "plain");
      selectText(block, 6, 11);
      await userEvent.keyboard(chord("b"));
      const span = block.querySelector("span")!;
      const restyle: CanvasChangedEvent = {
        type: "changed",
        scope: "work",
        workId: "work1",
        pageId: "page1",
        frameId: "f1",
        revision: 2,
        mutationId: "m_agent",
        updatedAt: at(5),
        previousUpdatedAt: at(1),
        delta: {
          operations: [
            {
              type: "set_attributes",
              nodeId: "box",
              attributes: {
                style:
                  "position:absolute;left:20px;top:160px;width:60px;height:40px;background:#ff0000",
              },
            },
          ],
          lastLayerEdit: { mutationId: "m_agent", fingerprint: "agent", createdNodeIds: [] },
        },
      };
      handleCanvasChanged(client, restyle);
      await vi.waitFor(() =>
        expect(getComputedStyle(layer("box")!).backgroundColor).toBe("rgb(255, 0, 0)"),
      );
      expect(block.querySelector("span")).toBe(span);
      expect(block.isContentEditable).toBe(true);
      expect(host("f1").shadowRoot!.activeElement).toBe(block);
      expect(shadowSelection(host("f1"))!.toString()).toBe("world");
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(storedRuns(server.frame("f1"), "plain")).toEqual([
        { text: "Hello ", style: "" },
        { text: "world", style: "font-weight:700" },
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("never selects a span as a layer: clicks, Cmd-clicks and the layers panel see the block", async () => {
    serveCanvas(native, work());
    const { screen, root, host, layer } = await mountCanvas(work(), { layers: true });
    try {
      const span = layer("rich")!.querySelector("span")!;
      expect(span.hasAttribute("data-synara-layer-id")).toBe(false);
      const box = span.getBoundingClientRect();
      const viewport = root.getBoundingClientRect();
      const x = box.left - viewport.left + box.width / 2;
      const y = box.top - viewport.top + box.height / 2;
      click(root, host("f1"), x, y);
      await vi.waitFor(() => expect(selection()).toEqual(["rich"]));
      select([]);
      await nextFrame();
      click(root, host("f1"), x, y, mod);
      await vi.waitFor(() => expect(selection()).toEqual(["rich"]));
      // Enter on the block edits it rather than selecting a child.
      root.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(mounted.editor!.editingText?.layerId).toBe("rich"));
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(mounted.editor!.editingText).toBeNull());
      // One row for the block, labelled with all of its text; none for the span.
      const row = document.querySelector('[data-layer-row="layer:f1:rich"]');
      expect(row?.textContent).toContain("Build faster today");
      expect(document.querySelector('[data-layer-row="layer:f1:rs"]')).toBeNull();
      // A plain text block still renders its text directly, with its own layer ID.
      expect(layer("plain")!.children).toHaveLength(0);
      expect(layer("plain")!.textContent).toBe("Hello world");
    } finally {
      await screen.unmount();
    }
  });

  it("bolds selected text layers without editing them, clearing their ranges, as one step", async () => {
    const server = serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      select([
        { kind: "layer", frameId: "f1", layerId: "plain" },
        { kind: "layer", frameId: "f1", layerId: "rich" },
      ]);
      root.focus();
      await nextFrame();
      await userEvent.keyboard(chord("b"));
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(operationsOf(0)).toEqual([
        { type: "set_styles", nodeId: "plain", styles: { "font-weight": "700" } },
        { type: "set_styles", nodeId: "rich", styles: { "font-weight": "700" } },
        { type: "delete", nodeId: "rs" },
        { type: "delete", nodeId: "r2" },
        { type: "set_text", nodeId: "r1", text: "Build faster today" },
      ]);
      // Every character is bold now: ⌘B again takes it off.
      await userEvent.keyboard(chord("b"));
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(2));
      expect(operationsOf(1)).toEqual([
        { type: "set_styles", nodeId: "plain", styles: { "font-weight": null } },
        { type: "set_styles", nodeId: "rich", styles: { "font-weight": null } },
      ]);
      await mounted.editor!.undo();
      await mounted.editor!.undo();
      await vi.waitFor(() =>
        expect(storedRuns(server.frame("f1"), "rich")).toEqual([
          { text: "Build ", style: "" },
          { text: "faster", style: "font-weight:700" },
          { text: " today", style: "" },
        ]),
      );
    } finally {
      await screen.unmount();
    }
  });
});
