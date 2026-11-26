import type { DesignLayerTree } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  elementChildren,
  frameAtPoint,
  holdsLayers,
  indexLayers,
  inheritsLock,
  isDoubleClick,
  isLayerLocked,
  isTextOnly,
  layerLabel,
  layerSiblings,
  marqueeSelection,
  orderHitStack,
  parentSelection,
  resolveClickSelection,
  resolveDrillSelection,
  toggleSelection,
  topLayers,
} from "./canvasSelection";

// page > (hero > (title > "Hello", button > "Go"), footer)
const tree: DesignLayerTree = {
  roots: ["page"],
  nodes: [
    {
      id: "page",
      type: "element",
      tag: "div",
      attributes: { class: "page" },
      children: ["hero", "footer"],
    },
    { id: "hero", type: "element", tag: "section", attributes: {}, children: ["title", "button"] },
    { id: "title", type: "element", tag: "h1", attributes: {}, children: ["t1"] },
    { id: "t1", type: "text", text: "Hello" },
    { id: "button", type: "element", tag: "button", attributes: {}, children: ["t2"] },
    { id: "t2", type: "text", text: "Go" },
    { id: "footer", type: "element", tag: "footer", attributes: {}, children: [] },
  ],
};
const index = indexLayers(tree);
const frame = { id: "f", width: 1000, height: 800, layers: tree };
const sizes: Record<string, { width: number; height: number }> = {
  page: { width: 1000, height: 800 },
  hero: { width: 1000, height: 400 },
};
const measure = (id: string) => sizes[id] ?? { width: 100, height: 40 };

describe("resolveClickSelection", () => {
  it("skips a full-bleed wrapper and selects the top-level layer under the pointer", () => {
    expect(
      resolveClickSelection({
        frame,
        index,
        hitLayerId: "title",
        selection: [],
        deep: false,
        measure,
      }),
    ).toEqual({ kind: "layer", frameId: "f", layerId: "hero" });
  });

  it("selects the deepest layer with Cmd/Ctrl", () => {
    expect(
      resolveClickSelection({
        frame,
        index,
        hitLayerId: "title",
        selection: [],
        deep: true,
        measure,
      }),
    ).toEqual({ kind: "layer", frameId: "f", layerId: "title" });
  });

  it("keeps a selected layer when clicking inside it, and stays at its depth for siblings", () => {
    const selected = [{ kind: "layer" as const, frameId: "f", layerId: "title" }];
    expect(
      resolveClickSelection({
        frame,
        index,
        hitLayerId: "t1",
        selection: selected,
        deep: false,
        measure,
      })?.kind,
    ).toBe("layer");
    expect(
      resolveClickSelection({
        frame,
        index,
        hitLayerId: "button",
        selection: selected,
        deep: false,
        measure,
      }),
    ).toEqual({ kind: "layer", frameId: "f", layerId: "button" });
  });

  it("does not select a frame with layers by its body; Cmd, a selected or an empty frame do", () => {
    const click = (input: Partial<Parameters<typeof resolveClickSelection>[0]>) =>
      resolveClickSelection({
        frame,
        index,
        hitLayerId: null,
        selection: [],
        deep: false,
        measure,
        ...input,
      });
    expect(click({})).toBeNull();
    expect(click({ deep: true })).toEqual({ kind: "frame", frameId: "f" });
    expect(click({ selection: [{ kind: "frame", frameId: "f" }] })).toEqual({
      kind: "frame",
      frameId: "f",
    });
    const empty = { ...frame, layers: { roots: [], nodes: [] } };
    expect(click({ frame: empty, index: indexLayers(empty.layers) })).toEqual({
      kind: "frame",
      frameId: "f",
    });
    // Only full-bleed wrappers under the pointer: that is the frame's body too.
    expect(click({ hitLayerId: "page" })).toBeNull();
  });

  it("keeps cousins one click away at the selection's depth", () => {
    // page > (a > (a1, a2), b > (b1)): a1 is selected; b1 is its cousin.
    const cousins: DesignLayerTree = {
      roots: ["a", "b"],
      nodes: [
        { id: "a", type: "element", tag: "div", attributes: {}, children: ["a1", "a2"] },
        { id: "a1", type: "element", tag: "div", attributes: {}, children: [] },
        { id: "a2", type: "element", tag: "div", attributes: {}, children: [] },
        { id: "b", type: "element", tag: "div", attributes: {}, children: ["b1"] },
        { id: "b1", type: "element", tag: "div", attributes: {}, children: [] },
      ],
    };
    const click = (hitLayerId: string, layerId = "a1") =>
      resolveClickSelection({
        frame: { ...frame, layers: cousins },
        index: indexLayers(cousins),
        hitLayerId,
        selection: [{ kind: "layer", frameId: "f", layerId }],
        deep: false,
        measure: () => ({ width: 10, height: 10 }),
      });
    expect(click("a2")).toEqual({ kind: "layer", frameId: "f", layerId: "a2" });
    expect(click("b1")).toEqual({ kind: "layer", frameId: "f", layerId: "b1" });
    // The parent's own area selects the parent; a top-level selection stays at the top level.
    expect(click("b")).toEqual({ kind: "layer", frameId: "f", layerId: "b" });
    expect(click("b1", "a")).toEqual({ kind: "layer", frameId: "f", layerId: "b" });
  });
});

describe("hit stack and double-click", () => {
  it("orders hits ancestors first and the deepest last; tolerance only reaches inside", () => {
    // Under the pointer: page > hero (topmost "hero"). Within 4px: title (inside hero) and
    // footer (outside it).
    expect(orderHitStack(index, tree.roots, ["hero", "page"], ["title", "footer"])).toEqual({
      stack: ["page", "hero", "title"],
      target: "title",
    });
    // The layer under the pointer wins over a neighbour a few pixels off.
    expect(orderHitStack(index, tree.roots, ["button", "hero", "page"], ["title"])).toEqual({
      stack: ["page", "hero", "button"],
      target: "button",
    });
    expect(orderHitStack(index, tree.roots, [], [])).toEqual({ stack: [], target: null });
  });

  it("counts a second press within 500 ms and 5 px as a double-click", () => {
    const first = { time: 0, x: 0, y: 0 };
    expect(isDoubleClick(first, { time: 500, x: 3, y: 4 })).toBe(true);
    expect(isDoubleClick(first, { time: 501, x: 0, y: 0 })).toBe(false);
    expect(isDoubleClick(first, { time: 100, x: 6, y: 0 })).toBe(false);
    expect(isDoubleClick(null, first)).toBe(false);
  });

  it("inherits locks from ancestors", () => {
    const locked = indexLayers({
      ...tree,
      nodes: tree.nodes.map((node) =>
        node.id === "hero" && node.type === "element"
          ? { ...node, attributes: { "data-locked": "true" } }
          : node,
      ),
    });
    expect(isLayerLocked(locked, "title")).toBe(true);
    expect(isLayerLocked(locked, "footer")).toBe(false);
    expect(inheritsLock(locked, "title")).toBe(true);
    expect(inheritsLock(locked, "hero")).toBe(false);
  });
});

describe("drill, parent and labels", () => {
  it("double-click goes one level deeper toward the pointer", () => {
    expect(
      resolveDrillSelection({
        frameId: "f",
        index,
        hitLayerId: "title",
        current: { kind: "layer", frameId: "f", layerId: "hero" },
      }),
    ).toEqual({ kind: "layer", frameId: "f", layerId: "title" });
  });

  it("Escape walks up to the frame", () => {
    expect(parentSelection(index, { kind: "layer", frameId: "f", layerId: "hero" })).toEqual({
      kind: "layer",
      frameId: "f",
      layerId: "page",
    });
    expect(parentSelection(index, { kind: "layer", frameId: "f", layerId: "page" })).toEqual({
      kind: "frame",
      frameId: "f",
    });
    expect(parentSelection(index, { kind: "frame", frameId: "f" })).toBeNull();
  });

  it("only text-only elements edit in place, and labels read like the layers panel", () => {
    expect(isTextOnly(index, "title")).toBe(true);
    expect(isTextOnly(index, "hero")).toBe(false);
    expect(layerLabel(index, "title")).toBe("Hello");
    expect(layerLabel(index, "page")).toBe("Frame · page");
    expect(layerLabel(index, "footer")).toBe("Footer");
  });

  it("names a long text layer by its whole text, cutting only past the limit with an ellipsis", () => {
    const sentence = "Ship twice as fast with unlimited projects and priority support.";
    const long = indexLayers({
      roots: ["p", "q"],
      nodes: [
        { id: "p", type: "element", tag: "p", attributes: {}, children: ["pt"] },
        { id: "pt", type: "text", text: sentence },
        { id: "q", type: "element", tag: "p", attributes: {}, children: ["qt"] },
        { id: "qt", type: "text", text: "word ".repeat(40) },
      ],
    });
    // The row truncates it to its width (with an ellipsis); the label is never cut mid-word.
    expect(layerLabel(long, "p")).toBe(sentence);
    const cut = layerLabel(long, "q");
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(120);
  });

  it("B3: an empty element is a container; an empty text element still edits as text", () => {
    expect(isTextOnly(index, "footer")).toBe(false);
    const empty = indexLayers({
      roots: ["box", "line"],
      nodes: [
        { id: "box", type: "element", tag: "div", attributes: {}, children: [] },
        { id: "line", type: "element", tag: "p", attributes: {}, children: [] },
      ],
    });
    expect(isTextOnly(empty, "box")).toBe(false);
    expect(isTextOnly(empty, "line")).toBe(true);
  });
});

describe("tree helpers", () => {
  it("finds siblings, element children and the top layers of a set", () => {
    expect(layerSiblings(index, tree.roots, "button")).toEqual({
      parentId: "hero",
      siblings: ["title", "button"],
    });
    expect(layerSiblings(index, tree.roots, "page")).toEqual({
      parentId: null,
      siblings: ["page"],
    });
    expect(elementChildren(index, tree.roots, { kind: "frame", frameId: "f" })).toEqual(["page"]);
    expect(
      elementChildren(index, tree.roots, { kind: "layer", frameId: "f", layerId: "title" }),
    ).toEqual([]);
    expect(topLayers(index, ["title", "hero", "footer"])).toEqual(["hero", "footer"]);
  });

  it("finds the front-most frame under a world point", () => {
    const frames = [
      { id: "back", x: 0, y: 0, width: 100, height: 100 },
      { id: "front", x: 50, y: 50, width: 100, height: 100 },
    ];
    expect(frameAtPoint(frames, { x: 60, y: 70 })).toMatchObject({
      frame: { id: "front" },
      x: 10,
      y: 20,
    });
    expect(frameAtPoint(frames, { x: 10, y: 10 })?.frame.id).toBe("back");
    expect(frameAtPoint(frames, { x: 500, y: 0 })).toBeNull();
  });
});

describe("marqueeSelection", () => {
  // page (0,0 1000×800) > hero (0,0 1000×400) > title (10,10 100×40), button (10,60 100×40);
  // footer (0,700 1000×100). The frame is at the origin at 100%.
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {
    page: { x: 0, y: 0, width: 1000, height: 800 },
    hero: { x: 0, y: 0, width: 1000, height: 400 },
    title: { x: 10, y: 10, width: 100, height: 40 },
    button: { x: 10, y: 60, width: 100, height: 40 },
    footer: { x: 0, y: 700, width: 1000, height: 100 },
  };
  const run = (rect: { x: number; y: number; width: number; height: number }, deep: boolean) => {
    const measured: string[] = [];
    const picked = marqueeSelection({
      frames: [{ id: "f", layers: tree }],
      rect,
      deep,
      frameRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      layerRect: (_frame, layerId) => {
        measured.push(layerId);
        return boxes[layerId] ?? null;
      },
      index: () => index,
    });
    return {
      picked: picked.map((item) => (item.kind === "frame" ? "frame" : item.layerId)),
      measured,
    };
  };

  it("selects a covered frame, or the top-level layers a partial box touches", () => {
    expect(run({ x: -10, y: -10, width: 2000, height: 2000 }, false).picked).toEqual(["frame"]);
    expect(run({ x: 5, y: 5, width: 50, height: 50 }, false).picked).toEqual(["page"]);
  });

  it("deep: picks the outermost contained layers, measuring each layer at most once", () => {
    const { picked, measured } = run({ x: 0, y: 0, width: 200, height: 120 }, true);
    expect(picked).toEqual(["title", "button"]);
    expect(new Set(measured).size).toBe(measured.length);
    // A contained layer's subtree is not walked: text children are never measured.
    expect(measured).not.toContain("t1");
  });

  it("deep: skips hidden and locked layers and everything under a locked one", () => {
    const flagged = indexLayers({
      ...tree,
      nodes: tree.nodes.map((node) =>
        node.id === "hero" && node.type === "element"
          ? { ...node, attributes: { ...node.attributes, "data-locked": "true" } }
          : node,
      ),
    });
    const measured: string[] = [];
    const picked = marqueeSelection({
      frames: [{ id: "f", layers: tree }],
      rect: { x: 0, y: 0, width: 1000, height: 799 },
      deep: true,
      frameRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      layerRect: (_frame, layerId) => {
        measured.push(layerId);
        return layerId === "page"
          ? { x: -1, y: 0, width: 1002, height: 800 }
          : (boxes[layerId] ?? null);
      },
      index: () => flagged,
    });
    expect(picked.map((item) => (item.kind === "layer" ? item.layerId : "frame"))).toEqual([
      "footer",
    ]);
    expect(measured).not.toContain("title");
  });

  it("selects only the frames it touches once it holds a whole frame (without Cmd)", () => {
    const frames = [
      { id: "a", layers: tree },
      { id: "b", layers: tree },
    ];
    const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
      a: { x: 0, y: 0, width: 100, height: 100 },
      b: { x: 150, y: 0, width: 100, height: 100 },
    };
    const picked = marqueeSelection({
      frames,
      rect: { x: -10, y: -10, width: 200, height: 50 },
      deep: false,
      frameRect: (id) => rects[id] ?? null,
      layerRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      index: () => index,
    });
    // "a" is not contained (100 tall), so nothing is: the touched layers of both count.
    expect(picked.map((item) => item.frameId)).toEqual(["a", "b"]);
    const whole = marqueeSelection({
      frames,
      rect: { x: -10, y: -10, width: 200, height: 200 },
      deep: false,
      frameRect: (id) => rects[id] ?? null,
      layerRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      index: () => index,
    });
    expect(whole).toEqual([
      { kind: "frame", frameId: "a" },
      { kind: "frame", frameId: "b" },
    ]);
  });

  it("deep: recurses into containers it only touches and picks touched leaves", () => {
    expect(run({ x: 50, y: 30, width: 20, height: 40 }, true).picked).toEqual(["title", "button"]);
    // Touching a container's empty area picks the container.
    expect(run({ x: 500, y: 300, width: 20, height: 20 }, true).picked).toEqual(["hero"]);
  });

  it("Shift toggles against the selection held before the marquee", () => {
    const a = { kind: "layer" as const, frameId: "f", layerId: "a" };
    const b = { kind: "layer" as const, frameId: "f", layerId: "b" };
    const c = { kind: "layer" as const, frameId: "f", layerId: "c" };
    expect(toggleSelection([a, b], [b, c])).toEqual([a, c]);
  });
});

describe("inline SVG as one layer", () => {
  // button > (svg > (g > path), "Go")
  const icon: DesignLayerTree = {
    roots: ["button"],
    nodes: [
      { id: "button", type: "element", tag: "button", attributes: {}, children: ["svg", "label"] },
      {
        id: "svg",
        type: "element",
        tag: "svg",
        attributes: { viewBox: "0 0 24 24", "aria-label": "Star" },
        children: ["g"],
      },
      { id: "g", type: "element", tag: "g", attributes: {}, children: ["path"] },
      { id: "path", type: "element", tag: "path", attributes: { d: "M0 0" }, children: [] },
      { id: "label", type: "text", text: "Go" },
    ],
  };
  const svgIndex = indexLayers(icon);

  it("indexes an SVG as a leaf and leaves its shapes out", () => {
    expect(svgIndex.nodes.get("svg")).toMatchObject({ tag: "svg", children: [] });
    expect(svgIndex.nodes.has("g")).toBe(false);
    expect(svgIndex.nodes.has("path")).toBe(false);
    expect(svgIndex.parent.get("svg")).toBe("button");
    expect(
      elementChildren(svgIndex, icon.roots, { kind: "layer", frameId: "f", layerId: "svg" }),
    ).toEqual([]);
    expect(isTextOnly(svgIndex, "svg")).toBe(false);
    expect(holdsLayers(svgIndex, "svg")).toBe(false);
    expect(holdsLayers(svgIndex, "button")).toBe(true);
    expect(layerLabel(svgIndex, "svg")).toBe("SVG · Star");
  });

  it("selects, drills and marquees the SVG whole", () => {
    const frameOf = { id: "f", width: 400, height: 300, layers: icon };
    expect(
      resolveClickSelection({
        frame: frameOf,
        index: svgIndex,
        hitLayerId: "svg",
        selection: [{ kind: "layer", frameId: "f", layerId: "button" }],
        deep: false,
        measure: () => ({ width: 24, height: 24 }),
      }),
    ).toEqual({ kind: "layer", frameId: "f", layerId: "button" });
    expect(
      resolveDrillSelection({
        frameId: "f",
        index: svgIndex,
        hitLayerId: "svg",
        current: { kind: "layer", frameId: "f", layerId: "svg" },
      }),
    ).toBeNull();
    expect(
      marqueeSelection({
        frames: [{ id: "f", layers: icon }],
        rect: { x: 0, y: 0, width: 10, height: 10 },
        deep: true,
        frameRect: () => ({ x: 0, y: 0, width: 400, height: 300 }),
        layerRect: () => ({ x: 0, y: 0, width: 24, height: 24 }),
        index: () => svgIndex,
      }),
    ).toEqual([{ kind: "layer", frameId: "f", layerId: "svg" }]);
  });
});

describe("rich text blocks", () => {
  // "Build faster today" with "faster" bold, beside a button whose span holds its whole label.
  const rich = indexLayers({
    roots: ["p", "button"],
    nodes: [
      { id: "p", type: "element", tag: "p", attributes: {}, children: ["t1", "s", "t2"] },
      { id: "t1", type: "text", text: "Build " },
      {
        id: "s",
        type: "element",
        tag: "span",
        attributes: { style: "font-weight:700" },
        children: ["t3"],
      },
      { id: "t3", type: "text", text: "faster" },
      { id: "t2", type: "text", text: " today" },
      { id: "button", type: "element", tag: "button", attributes: {}, children: ["label"] },
      { id: "label", type: "element", tag: "span", attributes: {}, children: ["t4"] },
      { id: "t4", type: "text", text: "Go" },
    ],
  });

  it("indexes a rich block as one text layer with all of its text, its spans left out", () => {
    expect(rich.nodes.has("s")).toBe(false);
    expect(rich.nodes.get("p")).toMatchObject({ children: ["t1", "t3", "t2"] });
    expect(rich.parent.get("t3")).toBe("p");
    expect(rich.richText.has("p")).toBe(true);
    expect(isTextOnly(rich, "p")).toBe(true);
    expect(holdsLayers(rich, "p")).toBe(false);
    expect(elementChildren(rich, ["p"], { kind: "layer", frameId: "f", layerId: "p" })).toEqual([]);
    expect(layerLabel(rich, "p")).toBe("Build faster today");
    // A span holding a whole label stays a layer of its own, as before.
    expect(rich.nodes.has("label")).toBe(true);
    expect(isTextOnly(rich, "button")).toBe(false);
    expect(isTextOnly(rich, "label")).toBe(true);
  });
});
