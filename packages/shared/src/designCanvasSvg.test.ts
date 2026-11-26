import { describe, expect, it } from "vitest";
import {
  DESIGN_SVG_TAGS,
  designSvgAttributeProblem,
  designSvgScopedId,
  designSvgUsesCurrentColor,
  scopeDesignSvgAttribute,
} from "./designCanvasSvg";
import { isDesignAttributeAllowed, validateDesignLayers } from "./designCanvasLayers";

const tree = (fill: string) => ({
  roots: ["s"],
  nodes: [
    { id: "s", type: "element" as const, tag: "svg", attributes: {}, children: ["p"] },
    { id: "p", type: "element" as const, tag: "path", attributes: { fill }, children: [] },
  ],
});

describe("designCanvasSvg", () => {
  it("allows only shapes, groups, gradients, clip paths, masks, title and desc", () => {
    expect([...DESIGN_SVG_TAGS].toSorted()).toEqual(
      [
        "circle",
        "clipPath",
        "defs",
        "desc",
        "ellipse",
        "g",
        "line",
        "linearGradient",
        "mask",
        "path",
        "polygon",
        "polyline",
        "radialGradient",
        "rect",
        "stop",
        "svg",
        "title",
      ].toSorted(),
    );
    for (const tag of [
      "script",
      "foreignObject",
      "style",
      "use",
      "image",
      "a",
      "animate",
      "set",
      "filter",
      "text",
      "pattern",
      "symbol",
    ])
      expect(DESIGN_SVG_TAGS.has(tag), tag).toBe(false);
  });

  it("checks every attribute value like inline CSS, with references only inside the SVG", () => {
    const allowed: Array<[string, string, string]> = [
      ["svg", "viewBox", "0 0 24 24"],
      ["svg", "preserveAspectRatio", "xMinYMax slice"],
      ["path", "fill", "currentColor"],
      ["path", "fill", "url(#g) #fff"],
      ["path", "stroke", "oklch(0.7 0.1 200 / 50%)"],
      ["path", "d", "M1.5-2e3L3 4z"],
      ["polygon", "points", "0,0 1,1 -2,3"],
      ["rect", "width", "50%"],
      ["rect", "rx", "auto"],
      ["g", "transform", "translate(2 3) rotate(45, 12, 12)"],
      ["g", "clip-path", "url(#c)"],
      ["g", "mask", "url('#m')"],
      ["radialGradient", "href", "#other"],
      ["stop", "offset", "40%"],
      ["path", "stroke-dasharray", "4 2"],
      ["path", "data-name", "Outline"],
    ];
    for (const [tag, name, value] of allowed)
      expect(designSvgAttributeProblem(tag, name, value), `${tag} ${name}="${value}"`).toBeNull();
    const refused: Array<[string, string, string]> = [
      ["path", "onclick", "x()"],
      ["path", "onClick", "x()"],
      ["path", "fill", "url(https://evil.example/a.svg#g)"],
      ["path", "fill", "url(data:image/png;base64,AAAA)"],
      ["path", "fill", "var(--accent)"],
      ["path", "fill", "attr(data-x)"],
      ["path", "stroke", "red; background: url(x)"],
      ["path", "fill", "javascript:alert(1)"],
      ["g", "clip-path", "url(other.svg#c)"],
      ["g", "mask", "url(#m) url(#n)"],
      ["g", "filter", "url(#f)"],
      ["path", "href", "#g"],
      ["linearGradient", "href", "https://evil.example/g.svg#g"],
      ["path", "xlink:href", "#g"],
      ["svg", "xml:base", "https://evil.example/"],
      ["svg", "xmlns", "http://www.w3.org/1999/xhtml"],
      ["rect", "width", "10vw"],
      ["rect", "width", "1rem"],
      ["path", "d", "M0 0 url(x)"],
      ["g", "transform", "translate(1) expression(x)"],
      ["path", "viewBox", "0 0 1 1"],
      ["svg", "viewBox", "0 0 1"],
      ["path", "id", "a b"],
      ["path", "id", "sc.x.y"],
    ];
    for (const [tag, name, value] of refused)
      expect(
        designSvgAttributeProblem(tag, name, value),
        `${tag} ${name}="${value}"`,
      ).not.toBeNull();
    // The layer's ID attribute is never accepted from content, on SVG or HTML.
    expect(isDesignAttributeAllowed("svg", "data-synara-layer-id", "x")).toBe(false);
  });

  it("scopes IDs and references to one SVG layer, leaving everything else alone", () => {
    const scoped = (id: string) => designSvgScopedId("layer_1", id);
    expect(scopeDesignSvgAttribute(scoped, "id", "g")).toBe("sc.layer_1.g");
    expect(scopeDesignSvgAttribute(scoped, "href", "#g")).toBe("#sc.layer_1.g");
    expect(scopeDesignSvgAttribute(scoped, "fill", "url('#g') red")).toBe("url(#sc.layer_1.g) red");
    expect(scopeDesignSvgAttribute(scoped, "clip-path", "url(#c)")).toBe("url(#sc.layer_1.c)");
    expect(scopeDesignSvgAttribute(scoped, "d", "M0 0")).toBe("M0 0");
  });

  it("knows when an SVG paints with currentColor", () => {
    expect(designSvgUsesCurrentColor(tree("currentColor"), "s")).toBe(true);
    expect(designSvgUsesCurrentColor(tree("#000"), "s")).toBe(false);
    expect(() => validateDesignLayers(tree("currentColor"))).not.toThrow();
  });
});
