import "../../../index.css";

import type { ContextMenuItem } from "@synara/contracts";
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

import { toastManager } from "../../ui/toast";
import { useCanvasEditorStore } from "../canvasStores";
import { flushCanvasCameras } from "./canvasCamera";
import {
  element,
  frameOf,
  mountCanvas,
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

// A flex card with two buttons, two free boxes and a text layer; a second frame to the right.
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
    element("pin", "position:absolute;left:300px;top:150px;width:40px;height:40px"),
    element(
      "note",
      "position:absolute;left:20px;top:200px;font-size:16px;margin:0",
      ["noteText"],
      "p",
    ),
    text("noteText", "Note"),
  ],
  ["card", "badge", "pin", "note"],
);
const f2 = frameOf("f2", [], [], { x: 450, y: 0, width: 100, height: 100 });
const work = () => workOf([f1, f2]);
const layerItem = (layerId: string) => ({ kind: "layer" as const, frameId: "f1", layerId });
const lastEdit = () => native.canvas.editLayers.mock.calls.at(-1)![0].edit;
const lastStyles = () =>
  lastEdit().operations.find((operation: { type: string }) => operation.type === "set_styles")
    ?.styles;
const menuItems = (call = -1) =>
  native.contextMenu.show.mock.calls.at(call)![0] as ContextMenuItem<string>[];
const rightClick = (target: Element, x: number, y: number) =>
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: x,
      clientY: y,
    }),
  );

/** The app's key cap with this shortcut, as a tooltip shows it. */
const kbd = (label: string) =>
  document.querySelector<HTMLElement>(`[data-slot="kbd"][aria-label="${label}"]`);
const row = (key: string) => document.querySelector<HTMLElement>(`[data-layer-row="${key}"]`);
const chevron = (key: string) => row(key)!.querySelector<HTMLButtonElement>("button")!;
const click = (target: Element, init: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
/** The layers-panel row whose rename field has focus. */
const renamingRow = () =>
  (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-layer-row]")?.dataset
    .layerRow;

describe("canvas editor commands", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.contextMenu.show.mockReset();
    native.canvas.fontCatalog.mockResolvedValue({ families: [], available: true });
    native.canvas.getAsset.mockRejectedValue(new Error("no assets in this test"));
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("opens Paste, Go to frame and Hide UI from a right-click on empty canvas", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      select([layerItem("badge")]);
      await nextFrame();
      const empty = viewportPoint(root, 500, 300);
      native.contextMenu.show.mockResolvedValueOnce("toggle-ui");
      rightClick(root, empty.x, empty.y);
      await vi.waitFor(() => expect(native.contextMenu.show).toHaveBeenCalledTimes(1));
      expect(menuItems().map((item) => item.label)).toEqual(["Paste", "Go to frame", "Hide UI"]);
      expect(menuItems()[1]!.children?.map((item) => item.label)).toEqual([
        "Next frame",
        "Previous frame",
      ]);
      // The right-click cleared the selection; the chosen row hid the UI.
      expect(selection()).toEqual([]);
      await vi.waitFor(() => expect(useCanvasEditorStore.getState().uiHidden).toBe(true));

      native.contextMenu.show.mockResolvedValueOnce("previous-frame");
      rightClick(root, empty.x, empty.y);
      await vi.waitFor(() => expect(selection()).toEqual(["frame:f2"]));
      expect(menuItems().at(-1)!.label).toBe("Show UI");
    } finally {
      await screen.unmount();
    }
  });

  it("clicks a 100 × 100 box centred on the press; Shift squares, Alt draws from the centre", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    const insertedHtml = () =>
      lastEdit().operations.find((operation: { type: string }) => operation.type === "insert_html")
        .html as string;
    const drag = async (from: [number, number], to: [number, number], init = {}) => {
      useCanvasEditorStore.getState().setTool("rectangle");
      await nextFrame();
      const start = viewportPoint(root, ...from);
      const end = viewportPoint(root, ...to);
      pointer(root, "pointerdown", start.x, start.y, init);
      pointer(root, "pointermove", (start.x + end.x) / 2, (start.y + end.y) / 2, init);
      pointer(root, "pointermove", end.x, end.y, init);
      pointer(root, "pointerup", end.x, end.y, init);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalled());
      const html = insertedHtml();
      native.canvas.editLayers.mockClear();
      return html;
    };
    try {
      expect(await drag([150, 250], [150, 250])).toContain(
        "left:100px;top:200px;width:100px;height:100px",
      );
      expect(await drag([100, 100], [130, 180], { shiftKey: true })).toContain(
        "left:100px;top:100px;width:80px;height:80px",
      );
      expect(await drag([200, 150], [230, 170], { altKey: true })).toContain(
        "left:170px;top:130px;width:60px;height:40px",
      );
      // On empty canvas a click with the Frame tool makes a 100 × 100 frame there.
      useCanvasEditorStore.getState().setTool("frame");
      await nextFrame();
      const at = viewportPoint(root, 520, 300);
      pointer(root, "pointerdown", at.x, at.y);
      pointer(root, "pointerup", at.x, at.y);
      await vi.waitFor(() => expect(native.canvas.restoreFrames).toHaveBeenCalled());
      expect(native.canvas.restoreFrames.mock.calls.at(-1)![0].frames[0]).toMatchObject({
        x: 470,
        y: 250,
        width: 100,
        height: 100,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("moves the box's origin with Space held while drawing", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      useCanvasEditorStore.getState().setTool("rectangle");
      await nextFrame();
      const start = viewportPoint(root, 100, 100);
      pointer(root, "pointerdown", start.x, start.y);
      pointer(root, "pointermove", start.x + 20, start.y + 20);
      key(root, { key: " ", code: "Space" });
      await nextFrame();
      // With Space down, the whole box travels 30 px right.
      pointer(root, "pointermove", start.x + 50, start.y + 20);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space" }));
      await nextFrame();
      pointer(root, "pointermove", start.x + 60, start.y + 40);
      pointer(root, "pointerup", start.x + 60, start.y + 40);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalled());
      expect(JSON.stringify(lastEdit())).toContain("left:130px;top:100px;width:30px;height:40px");
    } finally {
      await screen.unmount();
    }
  });

  it("resizes with ⌘ arrows, fits and fills with ⌘⌥⇧R / ⌘⌥⇧F and handle double-clicks", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([layerItem("badge")]);
      await nextFrame();
      key(root, { key: "ArrowRight", ...mod });
      await vi.waitFor(() => expect(lastStyles()).toMatchObject({ width: "41px" }));
      key(root, { key: "ArrowDown", shiftKey: true, ...mod });
      await vi.waitFor(() => expect(lastStyles()).toMatchObject({ height: "48px" }));
      // A frame resizes through the layout.
      select([{ kind: "frame", frameId: "f2" }]);
      await nextFrame();
      key(root, { key: "ArrowLeft", ...mod });
      await vi.waitFor(() =>
        expect(native.canvas.layout.mock.calls.at(-1)![0].frames[0]).toMatchObject({
          id: "f2",
          width: 99,
          height: 100,
        }),
      );

      select([layerItem("pin")]);
      await nextFrame();
      key(root, { key: "R", code: "KeyR", altKey: true, shiftKey: true, ...mod });
      await vi.waitFor(() =>
        expect(lastStyles()).toMatchObject({ width: "fit-content", height: "fit-content" }),
      );
      key(root, { key: "F", code: "KeyF", altKey: true, shiftKey: true, ...mod });
      await vi.waitFor(() => expect(lastStyles()).toMatchObject({ width: "100%", height: "100%" }));

      // Double-clicking a corner handle fits both sides; with Alt it fills them.
      select([layerItem("badge")]);
      await vi.waitFor(() => expect(root.querySelector('[data-canvas-handle="se"]')).toBeTruthy());
      await nextFrame();
      const doubleClick = (init: PointerEventInit = {}) => {
        const handle = root.querySelector('[data-canvas-handle="se"]')!;
        const box = handle.getBoundingClientRect();
        const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
        for (let press = 0; press < 2; press++) {
          pointer(handle, "pointerdown", x, y, init);
          pointer(handle, "pointerup", x, y, init);
        }
      };
      const before = native.canvas.editLayers.mock.calls.length;
      doubleClick();
      await vi.waitFor(() =>
        expect(native.canvas.editLayers.mock.calls.length).toBeGreaterThan(before),
      );
      expect(lastStyles()).toMatchObject({ width: "fit-content", height: "fit-content" });
      await sleep(600);
      await vi.waitFor(() => expect(root.querySelector('[data-canvas-handle="se"]')).toBeTruthy());
      doubleClick({ altKey: true });
      await vi.waitFor(() => expect(lastStyles()).toMatchObject({ width: "100%", height: "100%" }));
    } finally {
      await screen.unmount();
    }
  });

  it("aligns with ⌥ letters and distributes with ⌃⌥H", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      root.focus();
      select([layerItem("badge"), layerItem("pin")]);
      await nextFrame();
      key(root, { key: "å", code: "KeyA", altKey: true });
      // The right-hand box moves to the left edge of the two.
      await vi.waitFor(() => expect(JSON.stringify(lastEdit())).toContain('"left":"250px"'));
      if (isMac) {
        select([layerItem("badge"), layerItem("pin"), layerItem("note")]);
        await nextFrame();
        const calls = native.canvas.editLayers.mock.calls.length;
        key(root, { key: "˙", code: "KeyH", ctrlKey: true, altKey: true });
        await vi.waitFor(() =>
          expect(native.canvas.editLayers.mock.calls.length).toBeGreaterThan(calls),
        );
      }
    } finally {
      await screen.unmount();
    }
  });

  it("shows the key in the tooltips of the inspector's align and resize buttons", async () => {
    serveCanvas(native, work());
    const { screen } = await mountCanvas(work(), { inspector: true });
    try {
      select([layerItem("badge"), layerItem("pin")]);
      await userEvent.hover(page.getByRole("button", { name: "Align left" }));
      await vi.waitFor(() => expect(kbd(isMac ? "⌥A" : "Alt+A")).toBeTruthy());
      select([layerItem("pin")]);
      await userEvent.hover(page.getByRole("button", { name: "Hug the content" }));
      await vi.waitFor(() => expect(kbd(isMac ? "⌥⇧⌘R" : "Ctrl+Alt+Shift+R")).toBeTruthy());
    } finally {
      await screen.unmount();
    }
  });

  it("deselects with ⇧Esc and from the layer menu; Esc still selects the parent", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      root.focus();
      select([layerItem("one")]);
      await nextFrame();
      key(root, { key: "Escape" });
      await vi.waitFor(() => expect(selection()).toEqual(["card"]));
      select([layerItem("one")]);
      await nextFrame();
      key(root, { key: "Escape", shiftKey: true });
      await vi.waitFor(() => expect(selection()).toEqual([]));

      select([layerItem("badge")]);
      await nextFrame();
      native.contextMenu.show.mockResolvedValueOnce("deselect");
      const box = layer("badge")!.getBoundingClientRect();
      rightClick(root, box.left + 10, box.top + 10);
      await vi.waitFor(() => expect(native.contextMenu.show).toHaveBeenCalled());
      expect(menuItems().some((item) => item.id === "deselect" && item.label === "Deselect")).toBe(
        true,
      );
      await vi.waitFor(() => expect(selection()).toEqual([]));
    } finally {
      await screen.unmount();
    }
  });

  it("strikes text through with ⌘⇧X and from the Adjust text submenu", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      root.focus();
      select([layerItem("note")]);
      await nextFrame();
      key(root, { key: "X", code: "KeyX", shiftKey: true, ...mod });
      await vi.waitFor(() =>
        expect(lastStyles()).toMatchObject({ "text-decoration-line": "line-through" }),
      );

      // Text layers get the Adjust text submenu; a plain box does not.
      native.contextMenu.show.mockResolvedValueOnce("text-italic");
      const note = layer("note")!.getBoundingClientRect();
      rightClick(root, note.left + 4, note.top + 4);
      await vi.waitFor(() => expect(native.contextMenu.show).toHaveBeenCalledTimes(1));
      const adjust = menuItems().find((item) => item.label === "Adjust text")!;
      expect(adjust.children?.map((item) => item.id)).toEqual([
        "text-bold",
        "text-italic",
        "text-underline",
        "text-strikethrough",
        "text-left",
        "text-center",
        "text-right",
        "text-justify",
      ]);
      await vi.waitFor(() => expect(lastStyles()).toMatchObject({ "font-style": "italic" }));

      select([layerItem("badge")]);
      await nextFrame();
      native.contextMenu.show.mockResolvedValueOnce(null);
      const badge = layer("badge")!.getBoundingClientRect();
      rightClick(root, badge.left + 10, badge.top + 10);
      await vi.waitFor(() => expect(native.contextMenu.show).toHaveBeenCalledTimes(2));
      expect(menuItems().some((item) => item.label === "Adjust text")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("toasts the actions that change nothing on screen", async () => {
    serveCanvas(native, work());
    const add = vi.spyOn(toastManager, "add");
    const { screen, root } = await mountCanvas(work());
    const titles = () => add.mock.calls.map(([options]) => options.title);
    try {
      root.focus();
      select([layerItem("badge")]);
      await nextFrame();
      key(root, { key: "ç", code: "KeyC", altKey: true, ...mod });
      await vi.waitFor(() => expect(titles()).toContain("Styles copied"));
      key(root, { key: "5", code: "Digit5" });
      await vi.waitFor(() => expect(titles()).toContain("Opacity 50%"));
      key(root, { key: "C", code: "KeyC", shiftKey: true });
      await vi.waitFor(() => expect(titles()).toContain("Comments hidden"));
      key(root, { key: "C", code: "KeyC", shiftKey: true });
      await vi.waitFor(() => expect(titles()).toContain("Comments shown"));
      key(root, { key: "L", code: "KeyL", altKey: true, shiftKey: true, ...mod });
      await vi.waitFor(() => expect(titles()).toContain("All layers unlocked"));
    } finally {
      await screen.unmount();
    }
  });

  it("names the sizing mode in the size badge when it is not fixed", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    const badge = () =>
      root.querySelector<HTMLElement>("[data-canvas-selection-group] > div:last-child")
        ?.textContent;
    try {
      select([layerItem("badge")]);
      await vi.waitFor(() => expect(badge()).toBe("40 × 40"));
      select([layerItem("note")]);
      await vi.waitFor(() => expect(badge()).toMatch(/^Fit \d+ × Fit \d+$/));
    } finally {
      await screen.unmount();
    }
  });

  it("toggles comments from the zoom menu", async () => {
    serveCanvas(native, work());
    const { screen, root } = await mountCanvas(work());
    try {
      const zoom = root.querySelector<HTMLElement>("[data-canvas-zoom-corner] button")!;
      await userEvent.click(zoom);
      const item = page.getByRole("menuitemcheckbox", { name: /^Show comments/ });
      await expect.element(item).toHaveAttribute("aria-checked", "true");
      await item.click();
      await vi.waitFor(() => expect(useCanvasEditorStore.getState().commentsHidden).toBe(true));
    } finally {
      await screen.unmount();
    }
  });

  it("outlines a selected layer's flex parent and, on hover, its flex siblings, dashed", async () => {
    serveCanvas(native, work());
    const { screen, root, layer } = await mountCanvas(work());
    try {
      select([layerItem("one")]);
      await vi.waitFor(() => expect(root.querySelector("[data-canvas-flex-parent]")).toBeTruthy());
      const parent = root.querySelector<HTMLElement>("[data-canvas-flex-parent]")!;
      expect(getComputedStyle(parent).borderTopStyle).toBe("dashed");
      const card = layer("card")!.getBoundingClientRect();
      expect(parent.getBoundingClientRect().width).toBeCloseTo(card.width, 0);
      // A free box has no flex parent.
      select([layerItem("badge")]);
      await vi.waitFor(() => expect(root.querySelector("[data-canvas-flex-parent]")).toBeNull());

      // The card selected and one of its children hovered: the other child is outlined.
      select([layerItem("card")]);
      useCanvasEditorStore.getState().setPanelHover(layerItem("one"));
      await vi.waitFor(() =>
        expect(root.querySelectorAll("[data-canvas-flex-sibling]")).toHaveLength(1),
      );
      const sibling = root.querySelector<HTMLElement>("[data-canvas-flex-sibling]")!;
      expect(sibling.getBoundingClientRect().left).toBeCloseTo(
        layer("two")!.getBoundingClientRect().left,
        0,
      );
      // The hover outline itself is 2 px wide.
      const hover = root.querySelector<HTMLElement>("[data-canvas-hover-outline]")!;
      expect(getComputedStyle(hover).borderTopWidth).toBe("2px");
    } finally {
      await screen.unmount();
    }
  });

  it("marks the cover frame's label and hides a label that would cover the frame above", async () => {
    const below = frameOf("f3", [], [], { x: 0, y: 310, width: 200, height: 100 });
    const covered = { ...workOf([f1, f2, below]), cover: { pageId: "page1", frameId: "f1" } };
    serveCanvas(native, covered);
    const { screen, root } = await mountCanvas(covered);
    const label = (frameId: string) =>
      root.querySelector<HTMLElement>(`[data-canvas-frame-label="${frameId}"]`)!;
    try {
      await vi.waitFor(() => expect(label("f1")).toBeTruthy());
      expect(
        label("f1").querySelector("[data-canvas-cover-marker]")?.getAttribute("aria-label"),
      ).toBe("Cover");
      expect(label("f2").querySelector("[data-canvas-cover-marker]")).toBeNull();
      // f3 sits 10 px under f1: its label row would cover f1, so it stays hidden until selected.
      expect(getComputedStyle(label("f3")).display).toBe("none");
      expect(getComputedStyle(label("f2")).display).not.toBe("none");
      select([{ kind: "frame", frameId: "f3" }]);
      await vi.waitFor(() => expect(getComputedStyle(label("f3")).display).not.toBe("none"));
    } finally {
      await screen.unmount();
    }
  });
});

describe("canvas layers panel", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.contextMenu.show.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    vi.restoreAllMocks();
  });

  it("opens and closes a whole subtree with Alt-click on a chevron", async () => {
    serveCanvas(native, work());
    const { screen } = await mountCanvas(work(), { layers: true });
    try {
      await vi.waitFor(() => expect(row("frame:f1")).toBeTruthy());
      expect(row("layer:f1:card")).toBeNull();
      click(chevron("frame:f1"), { altKey: true });
      await vi.waitFor(() => expect(row("layer:f1:one")).toBeTruthy());
      click(chevron("frame:f1"), { altKey: true });
      await vi.waitFor(() => expect(row("layer:f1:card")).toBeNull());
      // A plain click opens one level: the card stays closed as the Alt-click left it.
      click(chevron("frame:f1"));
      await vi.waitFor(() => expect(row("layer:f1:card")).toBeTruthy());
      expect(row("layer:f1:one")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("saves a rename with Tab and renames the next row, Shift+Tab the previous one", async () => {
    serveCanvas(native, work());
    const { screen } = await mountCanvas(work(), { layers: true });
    try {
      select([layerItem("badge")]);
      await vi.waitFor(() => expect(row("layer:f1:badge")).toBeTruthy());
      row("layer:f1:badge")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await vi.waitFor(() => expect(renamingRow()).toBe("layer:f1:badge"));
      await userEvent.keyboard("Logo{Tab}");
      // Rows list the front-most layer first: after the badge comes the card.
      await vi.waitFor(() => expect(renamingRow()).toBe("layer:f1:card"));
      await vi.waitFor(() => expect(JSON.stringify(lastEdit())).toContain("Logo"));
      expect(selection()).toEqual(["card"]);
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await vi.waitFor(() => expect(renamingRow()).toBe("layer:f1:badge"));
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(renamingRow()).not.toBe("layer:f1:badge"));
    } finally {
      await screen.unmount();
    }
  });

  it("offers Collapse all on the panel's empty area", async () => {
    serveCanvas(native, work());
    const { screen } = await mountCanvas(work(), { layers: true });
    try {
      select([layerItem("one")]);
      await vi.waitFor(() => expect(row("layer:f1:one")).toBeTruthy());
      native.contextMenu.show.mockResolvedValueOnce("collapse-all");
      const tree = document.querySelector<HTMLElement>("[role=tree]")!;
      const box = tree.getBoundingClientRect();
      rightClick(tree, box.left + 20, box.bottom - 10);
      await vi.waitFor(() => expect(native.contextMenu.show).toHaveBeenCalledTimes(1));
      expect(menuItems().map((item) => item.label)).toEqual(["Collapse all"]);
      await vi.waitFor(() => expect(row("layer:f1:one")).toBeNull());
      expect(row("frame:f1")).toBeTruthy();
    } finally {
      await screen.unmount();
    }
  });
});
