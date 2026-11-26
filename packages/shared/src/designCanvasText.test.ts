import type { DesignLayer, DesignLayerTree } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  applyDesignLayerEdits,
  DESIGN_HTML_TAGS,
  validateDesignLayers,
} from "./designCanvasLayers";
import {
  DESIGN_TEXT_TAGS,
  designTextBlockKind,
  designTextBlockText,
  designTextEditOperations,
  designTextRangeSpans,
  designTextRuns,
  hoistDesignTextRuns,
  normalizeDesignTextRuns,
  overlayDesignTextStyle,
  patchDesignTextStyle,
  pushDownDesignTextStyle,
  sameDesignTextStyle,
  styleDesignTextRange,
  type DesignTextRun,
} from "./designCanvasText";

const element = (
  id: string,
  tag: string,
  children: string[],
  attributes: Record<string, string> = {},
): DesignLayer => ({ id, type: "element", tag, attributes, children });
const text = (id: string, value: string): DesignLayer => ({ id, type: "text", text: value });
const mapOf = (nodes: readonly DesignLayer[]) => new Map(nodes.map((node) => [node.id, node]));

/** "Build faster today", with "faster" bold. */
const block = (): DesignLayerTree => ({
  roots: ["p"],
  nodes: [
    element("p", "p", ["t1", "s1", "t2"], { style: "font-size:24px" }),
    text("t1", "Build "),
    element("s1", "span", ["t3"], { style: "font-weight:700" }),
    text("t3", "faster"),
    text("t2", " today"),
  ],
});

function idSource() {
  let next = 0;
  return () => `new${++next}`;
}

/** Applies the commit to the tree, as every client replays it, and checks the result. */
function commit(tree: DesignLayerTree, runs: DesignTextRun[], id = "p") {
  const operations = designTextEditOperations(mapOf(tree.nodes), id, runs, idSource());
  if (!operations) return { operations, tree };
  const next = applyDesignLayerEdits(tree, operations);
  validateDesignLayers(next);
  return { operations, tree: next };
}

describe("text block predicate", () => {
  it("tells plain text, rich text and mixed content apart", () => {
    const nodes = mapOf([
      ...block().nodes,
      element("plain", "h1", ["a"]),
      text("a", "Title"),
      element("empty", "p", []),
      element("box", "div", []),
      element("flex", "div", ["s2"], { style: "display:flex" }),
      element("s2", "span", ["b"], { style: "color:red" }),
      text("b", "x"),
      element("named", "p", ["s3"]),
      element("s3", "span", ["c"], { "data-name": "Accent" }),
      text("c", "y"),
      element("boxed", "p", ["s4"]),
      element("s4", "span", ["d"], { style: "background:#ff0;padding:2px" }),
      text("d", "z"),
      element("mixed", "p", ["e", "inner"]),
      text("e", "Hi "),
      element("inner", "div", ["f"]),
      text("f", "there"),
      element("nested", "p", ["s5"]),
      element("s5", "span", ["s6"], { style: "color:red" }),
      element("s6", "span", ["g"], { style: "font-weight:700" }),
      text("g", "deep"),
      element("option", "option", ["h0", "s7"]),
      text("h0", "a"),
      element("s7", "span", ["h"], { style: "color:red" }),
      text("h", "o"),
      element("image", "img", []),
      // A button's label: one span holding all of the text is a layer.
      element("button", "button", ["w1", "s8", "w2"]),
      text("w1", "\n  "),
      element("s8", "span", ["i"], { style: "font-weight:600" }),
      text("i", "Get started"),
      text("w2", "\n"),
      // Two ranges and no text of the block's own still make a mixed text.
      element("pair", "p", ["s9", "s10"]),
      element("s9", "span", ["j"], { style: "color:red" }),
      text("j", "Red "),
      element("s10", "span", ["k"], { style: "color:blue" }),
      text("k", "blue"),
    ]);
    expect(designTextBlockKind(nodes, "p")).toBe("rich");
    expect(designTextBlockKind(nodes, "plain")).toBe("plain");
    expect(designTextBlockKind(nodes, "empty")).toBe("plain");
    expect(designTextBlockKind(nodes, "box")).toBeNull();
    // Flex makes each span a box of its own; a span with other attributes, layout styles or a
    // nested element is a layer; text next to a block child is mixed content.
    for (const id of ["flex", "named", "boxed", "mixed", "nested", "option", "image", "button"])
      expect(designTextBlockKind(nodes, id), id).toBeNull();
    expect(designTextBlockKind(nodes, "pair")).toBe("rich");
    expect(designTextBlockKind(nodes, "s1")).toBe("plain");
    expect(designTextRangeSpans(nodes, "p")).toEqual(["s1"]);
    expect(designTextRangeSpans(nodes, "plain")).toEqual([]);
    expect(designTextBlockText(nodes, "p")).toBe("Build faster today");
  });

  it("reads a block as runs with the span each came from", () => {
    expect(designTextRuns(mapOf(block().nodes), "p")).toEqual([
      { text: "Build ", style: "" },
      { text: "faster", style: "font-weight:700", source: "s1" },
      { text: " today", style: "" },
    ]);
  });
});

describe("normalization", () => {
  it("merges equal neighbours, drops empty runs, unwraps unstyled ones and is idempotent", () => {
    const runs: DesignTextRun[] = [
      { text: "A", style: "color:red", source: "s1" },
      { text: "", style: "font-weight:700", source: "s2" },
      { text: "B", style: "color: red", source: "s3" },
      { text: "C", style: "", source: "s4" },
      { text: "D", style: "" },
      { text: "E", style: "color:red;padding:4px" },
    ];
    const normal = normalizeDesignTextRuns(runs);
    expect(normal).toEqual([
      { text: "AB", style: "color:red", source: "s1" },
      { text: "CD", style: "" },
      // Only range declarations stay on a span.
      { text: "E", style: "color:red" },
    ]);
    expect(normalizeDesignTextRuns(normal)).toEqual(normal);
  });

  it("splits a range, keeps the source on every piece, and never nests", () => {
    const runs = designTextRuns(mapOf(block().nodes), "p");
    // Italic over "ld fa": the bold span splits in two, plain text gets its own italic piece.
    const styled = styleDesignTextRange(runs, 3, 8, { "font-style": "italic" });
    expect(styled).toEqual([
      { text: "Bui", style: "" },
      { text: "ld ", style: "font-style:italic" },
      { text: "fa", style: "font-weight:700;font-style:italic", source: "s1" },
      { text: "ster", style: "font-weight:700", source: "s1" },
      { text: " today", style: "" },
    ]);
    // Removing the bold from all of "faster" unwraps it into the plain text around it.
    expect(styleDesignTextRange(runs, 6, 12, { "font-weight": null })).toEqual([
      { text: "Build faster today", style: "" },
    ]);
    // Properties a range may not carry are ignored.
    expect(styleDesignTextRange(runs, 0, 5, { padding: "4px" })).toEqual(
      normalizeDesignTextRuns(runs),
    );
    expect(overlayDesignTextStyle("color:red;font-weight:400", "font-weight:700")).toBe(
      "color:red;font-weight:700",
    );
  });

  it("hoists a range over all of the text onto the block", () => {
    expect(hoistDesignTextRuns([{ text: "All", style: "font-weight:700", source: "s" }])).toEqual({
      runs: [{ text: "All", style: "" }],
      style: new Map([["font-weight", "700"]]),
    });
    const mixed = [
      { text: "A", style: "" },
      { text: "B", style: "color:red" },
    ];
    expect(hoistDesignTextRuns(mixed)).toEqual({ runs: mixed, style: null });
  });

  it("patches styles so a set declaration wins over a shorthand, and compares them unordered", () => {
    expect(patchDesignTextStyle("font:400 16px Inter;color:red", { "font-weight": "700" })).toBe(
      "font:400 16px Inter;color:red;font-weight:700",
    );
    expect(patchDesignTextStyle("color:red", { color: null })).toBe("");
    expect(sameDesignTextStyle("color:red;font-weight:700", "font-weight: 700; color: red")).toBe(
      true,
    );
    expect(sameDesignTextStyle("color:red", "color:blue")).toBe(false);
    expect(
      pushDownDesignTextStyle(
        [
          { text: "a", style: "" },
          { text: "b", style: "text-decoration-line:none" },
        ],
        new Map([["text-decoration-line", "underline"]]),
      ),
    ).toEqual([
      { text: "a", style: "text-decoration-line:underline" },
      { text: "b", style: "text-decoration-line:none" },
    ]);
  });
});

describe("commit operations", () => {
  it("bolds a word with one new span and the plain text around it kept", () => {
    const tree: DesignLayerTree = {
      roots: ["p"],
      nodes: [element("p", "p", ["t1"]), text("t1", "Hello world")],
    };
    const runs = styleDesignTextRange(designTextRuns(mapOf(tree.nodes), "p"), 6, 11, {
      "font-weight": "700",
    });
    const { operations, tree: next } = commit(tree, runs);
    expect(operations).toEqual([
      { type: "set_text", nodeId: "t1", text: "Hello " },
      {
        type: "insert_layers",
        parentId: "p",
        layers: {
          roots: ["new2"],
          nodes: [
            {
              id: "new2",
              type: "element",
              tag: "span",
              attributes: { style: "font-weight:700" },
              children: ["new1"],
            },
            { id: "new1", type: "text", text: "world" },
          ],
        },
      },
    ]);
    expect(designTextBlockKind(mapOf(next.nodes), "p")).toBe("rich");
    // Toggling it off again merges back to plain text with no span left.
    const off = commit(
      next,
      styleDesignTextRange(designTextRuns(mapOf(next.nodes), "p"), 6, 11, { "font-weight": null }),
    );
    expect(off.operations).toEqual([
      { type: "delete", nodeId: "new2" },
      { type: "set_text", nodeId: "t1", text: "Hello world" },
    ]);
    expect(off.tree.nodes).toEqual([element("p", "p", ["t1"]), text("t1", "Hello world")]);
  });

  it("keeps the IDs of ranges the edit leaves alone and of spans that only changed text", () => {
    const tree = block();
    const runs = designTextRuns(mapOf(tree.nodes), "p");
    // Typing inside the bold range keeps the span and only retexts it.
    const typed = commit(tree, [runs[0]!, { ...runs[1]!, text: "fastest" }, runs[2]!]);
    expect(typed.operations).toEqual([{ type: "set_text", nodeId: "t3", text: "fastest" }]);
    // Bolding "today" too keeps "faster" (s1) as it is and adds one span after it.
    const more = commit(tree, styleDesignTextRange(runs, 13, 18, { "font-weight": "700" }));
    expect(more.operations).toEqual([
      { type: "set_text", nodeId: "t2", text: " " },
      expect.objectContaining({ type: "insert_layers", parentId: "p" }),
    ]);
    expect(designTextRangeSpans(mapOf(more.tree.nodes), "p")[0]).toBe("s1");
    expect(designTextBlockText(mapOf(more.tree.nodes), "p")).toBe("Build faster today");
    // Unbolding the head of the span keeps its ID on the part that stays bold.
    const head = commit(tree, styleDesignTextRange(runs, 6, 8, { "font-weight": null }));
    expect(head.operations).toEqual([
      { type: "set_text", nodeId: "t1", text: "Build fa" },
      { type: "set_text", nodeId: "t3", text: "ster" },
    ]);
  });

  it("restyles a kept span in place and merges neighbours that end up equal", () => {
    const tree = block();
    const runs = designTextRuns(mapOf(tree.nodes), "p");
    const recolored = commit(tree, styleDesignTextRange(runs, 6, 12, { color: "#ff0000" }));
    expect(recolored.operations).toEqual([
      {
        type: "set_attributes",
        nodeId: "s1",
        attributes: { style: "font-weight:700;color:#ff0000" },
      },
    ]);
    // Two spans with the same style become one, keeping the first.
    const twins: DesignLayerTree = {
      roots: ["p"],
      nodes: [
        element("p", "p", ["a", "b"]),
        element("a", "span", ["ta"], { style: "color:red" }),
        text("ta", "Hel"),
        element("b", "span", ["tb"], { style: "color:red" }),
        text("tb", "lo"),
      ],
    };
    const twinRuns = designTextRuns(mapOf(twins.nodes), "p");
    // Nothing typed: the grouping alone is not a change.
    expect(designTextEditOperations(mapOf(twins.nodes), "p", twinRuns, idSource())).toBeNull();
    const merged = commit(twins, [twinRuns[0]!, { ...twinRuns[1]!, text: "lo!" }]);
    expect(merged.operations).toEqual([
      { type: "delete", nodeId: "b" },
      { type: "set_text", nodeId: "ta", text: "Hello!" },
    ]);
  });

  it("deletes in document order so an undo restores each in place, and writes new text", () => {
    const tree: DesignLayerTree = {
      roots: ["p"],
      nodes: [
        element("p", "p", ["a", "s", "b"]),
        text("a", "x"),
        element("s", "span", ["st"], { style: "color:red" }),
        text("st", "y"),
        text("b", "z"),
      ],
    };
    const { operations, tree: next } = commit(tree, [{ text: "only", style: "" }]);
    expect(operations).toEqual([
      { type: "delete", nodeId: "s" },
      { type: "delete", nodeId: "b" },
      { type: "set_text", nodeId: "a", text: "only" },
    ]);
    expect(next.nodes).toEqual([element("p", "p", ["a"]), text("a", "only")]);
    // An empty block gets its text inserted.
    const empty: DesignLayerTree = { roots: ["p"], nodes: [element("p", "p", [])] };
    const filled = commit(empty, [
      { text: "Hi ", style: "" },
      { text: "there", style: "font-style:italic" },
    ]);
    expect(designTextRuns(mapOf(filled.tree.nodes), "p")).toEqual([
      { text: "Hi ", style: "" },
      { text: "there", style: "font-style:italic", source: "new3" },
    ]);
  });

  it("is idempotent: the runs of a committed block commit to nothing", () => {
    const tree = block();
    const runs = styleDesignTextRange(designTextRuns(mapOf(tree.nodes), "p"), 0, 5, {
      color: "#123456",
    });
    const { tree: next } = commit(tree, runs);
    const again = designTextRuns(mapOf(next.nodes), "p");
    expect(designTextEditOperations(mapOf(next.nodes), "p", again, idSource())).toBeNull();
    expect(again.map(({ text, style }) => ({ text, style }))).toEqual(
      normalizeDesignTextRuns(runs).map(({ text, style }) => ({ text, style })),
    );
  });
});

it("names only tags a layer can have as text holders", () => {
  // The importer stores abbr, cite, q, time and the other phrasing tags as span, legend as div.
  for (const tag of DESIGN_TEXT_TAGS) expect(DESIGN_HTML_TAGS.has(tag), tag).toBe(true);
  for (const tag of ["abbr", "cite", "legend", "q", "time"])
    expect(DESIGN_TEXT_TAGS.has(tag), tag).toBe(false);
});
