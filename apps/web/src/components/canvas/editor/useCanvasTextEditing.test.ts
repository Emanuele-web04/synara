import { describe, expect, it } from "vitest";
import { indexLayers } from "./canvasSelection";
import { nextTextLayer, textEditOperations } from "./useCanvasTextEditing";

const index = indexLayers({
  roots: ["p", "q", "empty"],
  nodes: [
    { id: "p", type: "element", tag: "p", attributes: {}, children: ["t1", "t2"] },
    { id: "t1", type: "text", text: "Hello " },
    { id: "t2", type: "text", text: "world" },
    { id: "q", type: "element", tag: "p", attributes: {}, children: ["t3"] },
    { id: "t3", type: "text", text: "Same" },
    { id: "empty", type: "element", tag: "span", attributes: {}, children: [] },
  ],
});

describe("textEditOperations", () => {
  it("writes the text into the first text child and removes the others", () => {
    expect(textEditOperations(index, "p", "Hi")).toEqual([
      { type: "set_text", nodeId: "t1", text: "Hi" },
      { type: "delete", nodeId: "t2" },
    ]);
  });

  it("sends nothing when the text did not change", () => {
    expect(textEditOperations(index, "q", "Same")).toBeNull();
    expect(textEditOperations(index, "empty", "")).toBeNull();
  });

  it("inserts escaped text into an empty text layer", () => {
    expect(textEditOperations(index, "empty", "a < b & c")).toEqual([
      { type: "insert_html", parentId: "empty", html: "a &lt; b &amp; c" },
    ]);
  });
});

const at = (frameId: string, layerId: string) => ({ kind: "layer" as const, frameId, layerId });

describe("text editing rules", () => {
  it("deletes a layer left empty and keeps line breaks with pre-wrap", () => {
    expect(textEditOperations(index, "q", "  ")).toEqual([{ type: "delete", nodeId: "q" }]);
    expect(textEditOperations(index, "q", "a\nb", { collapsesNewlines: true })).toEqual([
      { type: "set_text", nodeId: "t3", text: "a\nb" },
      { type: "set_styles", nodeId: "q", styles: { "white-space": "pre-wrap" } },
    ]);
    expect(textEditOperations(index, "q", "a\nb", { collapsesNewlines: false })).toEqual([
      { type: "set_text", nodeId: "t3", text: "a\nb" },
    ]);
  });

  it("Tab walks the page's text layers in tree order, wrapping, past locked and hidden ones", () => {
    const frames = [
      {
        id: "a",
        layers: {
          roots: ["p", "q", "empty"],
          nodes: [...index.nodes.values()].map((node) =>
            node.id === "q" && node.type === "element"
              ? Object.assign({}, node, { attributes: { "data-locked": "true" } })
              : node,
          ),
        },
      },
      {
        id: "b",
        layers: {
          roots: ["h"],
          nodes: [{ id: "h", type: "element" as const, tag: "h1", attributes: {}, children: [] }],
        },
      },
    ];
    const indexes = new Map(frames.map((frame) => [frame.id, indexLayers(frame.layers)]));
    const next = (from: ReturnType<typeof at>, step: 1 | -1) =>
      nextTextLayer(frames, (id) => indexes.get(id), from, step);
    expect(next(at("a", "p"), 1)).toEqual(at("a", "empty"));
    expect(next(at("a", "empty"), 1)).toEqual(at("b", "h"));
    expect(next(at("b", "h"), 1)).toEqual(at("a", "p"));
    expect(next(at("a", "p"), -1)).toEqual(at("b", "h"));
  });
});
