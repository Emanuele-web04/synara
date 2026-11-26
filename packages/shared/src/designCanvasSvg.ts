// FILE: designCanvasSvg.ts
// Purpose: The inline SVG subset canvas layers may hold, shared by the server (authoritative, on
//          import and on every validation) and the renderer (again, before anything reaches the
//          DOM): the allowed elements, each attribute's value rule, and the per-SVG ID scope that
//          keeps one SVG's gradients and clip paths out of reach of every other layer.
// Layer: Canvas shared model, pure (no DOM, no parsing)
// Exports: DESIGN_SVG_NAMESPACE, DESIGN_SVG_TAGS, DESIGN_SVG_TEXT_TAGS, DESIGN_SVG_ID_PREFIX,
//          designSvgAttributeProblem, designSvgScopedId, scopeDesignSvgAttribute,
//          designSvgUsesCurrentColor

import type { DesignLayerTree } from "@synara/contracts";

export const DESIGN_SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Every element an SVG layer may contain, its `svg` root included. Names are case-sensitive, as
 * in SVG. Shapes, groups, gradients, clip paths and masks only: nothing that runs script, embeds
 * HTML, loads or references other content (`use`, `image`, `a`), animates, or styles by sheet.
 * `mask` holds the same shapes as `clipPath` and is reached only through the SVG's own scoped
 * IDs, so it can paint nothing a clip path could not. `title` and `desc` are the accessible name
 * and description; they hold text only.
 */
export const DESIGN_SVG_TAGS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "title",
  "desc",
]);

/** SVG elements that hold text (and only text). Text anywhere else in an SVG is not kept. */
export const DESIGN_SVG_TEXT_TAGS: ReadonlySet<string> = new Set(["title", "desc"]);

const GRADIENT_TAGS = new Set(["linearGradient", "radialGradient"]);

/**
 * Rendered SVG IDs start with this. It holds a dot, which no layer ID can, so `sc.<svg layer
 * ID>.<id>` is unique to one SVG layer of a frame; HTML IDs with this prefix are not rendered.
 */
export const DESIGN_SVG_ID_PREFIX = "sc.";

const SVG_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;
/** `url(#id)`: the only reference an SVG may make, to an element of the same SVG. */
const FRAGMENT_URL = /url\(\s*(["']?)#([A-Za-z_][A-Za-z0-9_-]{0,79})\1\s*\)/g;
const ANY_URL = /url\s*\(/i;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// No rem or viewport units: they would follow Synara's own document, not the frame.
const LENGTH =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:px|em|ex|ch|pt|pc|cm|mm|in|q|%)?$/i;
const PERCENT_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/;
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]*$/;
const NUMBER_LIST = /^[0-9eE.,+\-\s]*$/;
const TRANSFORM_FUNCTION = /(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([0-9eE.,+\-\s]*\)/g;
const COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
]);
const COLOR_CHARACTERS = /^[#A-Za-z0-9\s.,%()+\-/]*$/;
const MAX_VALUE = 1024;

const tokens = (value: string) =>
  value
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
const keywords =
  (...allowed: string[]) =>
  (value: string) =>
    allowed.includes(value.trim()) ? null : "has an unsupported value";
const matches = (pattern: RegExp) => (value: string) =>
  pattern.test(value.trim()) ? null : "has an unsupported value";

/** A colour (or paint) value: plain colours and colour functions, `url(#id)` where allowed. */
function colorProblem(value: string, references: boolean): string | null {
  if (value.length > MAX_VALUE) return "is too long";
  const rest = references ? value.replace(FRAGMENT_URL, " ") : value;
  if (ANY_URL.test(rest))
    return references ? "may only reference an element of its own SVG" : "loads a resource";
  if (!COLOR_CHARACTERS.test(rest)) return "has an unsupported value";
  for (const match of rest.matchAll(/([A-Za-z-]+)\s*\(/g))
    if (!COLOR_FUNCTIONS.has(match[1]!.toLowerCase())) return `uses ${match[1]}()`;
  return null;
}

const length = (value: string) => (LENGTH.test(value.trim()) ? null : "has an unsupported value");
const lengthOrAuto = (value: string) => (value.trim() === "auto" ? null : length(value));
const percentNumber = matches(PERCENT_NUMBER);
const number = matches(NUMBER);
const transform = (value: string) =>
  value.length <= MAX_VALUE && /^[\s,]*$/.test(value.replace(TRANSFORM_FUNCTION, " "))
    ? null
    : "has an unsupported value";

type Rule = (value: string, tag: string) => string | null;

/** Each allowed SVG attribute and the check its value must pass (case-sensitive names). */
const SVG_ATTRIBUTES: Readonly<Record<string, Rule>> = {
  // Generic attributes, as on HTML layers. `style` is checked by the CSS sanitizers.
  id: (value) => (SVG_ID.test(value) ? null : "must be a plain identifier"),
  class: () => null,
  style: () => null,
  role: () => null,
  "aria-hidden": () => null,
  "aria-label": () => null,
  "aria-labelledby": () => null,
  "aria-describedby": () => null,
  // Geometry.
  viewBox: (value, tag) =>
    tag === "svg" && tokens(value).length === 4 && tokens(value).every((item) => NUMBER.test(item))
      ? null
      : "has an unsupported value",
  preserveAspectRatio: (value, tag) =>
    tag === "svg" &&
    /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?$/.test(value.trim())
      ? null
      : "has an unsupported value",
  x: length,
  y: length,
  width: lengthOrAuto,
  height: lengthOrAuto,
  x1: length,
  y1: length,
  x2: length,
  y2: length,
  cx: length,
  cy: length,
  r: length,
  rx: lengthOrAuto,
  ry: lengthOrAuto,
  fx: length,
  fy: length,
  fr: length,
  d: (value) => (PATH_DATA.test(value) ? null : "is not path data"),
  points: (value) =>
    NUMBER_LIST.test(value) && tokens(value).every((item) => NUMBER.test(item))
      ? null
      : "has an unsupported value",
  pathLength: number,
  offset: percentNumber,
  transform,
  gradientTransform: transform,
  // Painting.
  fill: (value) => colorProblem(value, true),
  stroke: (value) => colorProblem(value, true),
  color: (value) => colorProblem(value, false),
  "stop-color": (value) => colorProblem(value, false),
  opacity: percentNumber,
  "fill-opacity": percentNumber,
  "stroke-opacity": percentNumber,
  "stop-opacity": percentNumber,
  "fill-rule": keywords("nonzero", "evenodd", "inherit"),
  "clip-rule": keywords("nonzero", "evenodd", "inherit"),
  "stroke-width": length,
  "stroke-linecap": keywords("butt", "round", "square", "inherit"),
  "stroke-linejoin": keywords("miter", "miter-clip", "round", "bevel", "arcs", "inherit"),
  "stroke-miterlimit": number,
  "stroke-dasharray": (value) =>
    value.trim() === "none" ||
    (value.length <= MAX_VALUE &&
      tokens(value).length > 0 &&
      tokens(value).every((item) => LENGTH.test(item)))
      ? null
      : "has an unsupported value",
  "stroke-dashoffset": length,
  "paint-order": matches(/^(?:normal|(?:fill|stroke|markers)(?:\s+(?:fill|stroke|markers)){0,2})$/),
  "vector-effect": keywords("none", "non-scaling-stroke"),
  "shape-rendering": keywords("auto", "optimizeSpeed", "crispEdges", "geometricPrecision"),
  "color-interpolation": keywords("auto", "sRGB", "linearRGB"),
  "transform-origin": (value) =>
    value.length <= 64 && /^[a-z0-9.%\s+-]+$/i.test(value) ? null : "has an unsupported value",
  visibility: keywords("visible", "hidden", "collapse", "inherit"),
  display: keywords("none", "inline", "block", "inline-block", "inherit"),
  overflow: keywords("visible", "hidden", "auto", "scroll", "clip", "inherit"),
  // References: only to an element of the same SVG (scoped when rendered).
  "clip-path": (value) =>
    value.trim() === "none" ||
    /^url\(\s*(["']?)#[A-Za-z_][A-Za-z0-9_-]{0,79}\1\s*\)$/.test(value.trim())
      ? null
      : "may only reference an element of its own SVG",
  mask: (value) =>
    value.trim() === "none" ||
    /^url\(\s*(["']?)#[A-Za-z_][A-Za-z0-9_-]{0,79}\1\s*\)$/.test(value.trim())
      ? null
      : "may only reference an element of its own SVG",
  // A gradient may inherit the stops of another gradient of the same SVG.
  href: (value, tag) =>
    GRADIENT_TAGS.has(tag) && /^#[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(value.trim())
      ? null
      : "may only point a gradient at another gradient of its own SVG",
  gradientUnits: keywords("userSpaceOnUse", "objectBoundingBox"),
  clipPathUnits: keywords("userSpaceOnUse", "objectBoundingBox"),
  maskUnits: keywords("userSpaceOnUse", "objectBoundingBox"),
  maskContentUnits: keywords("userSpaceOnUse", "objectBoundingBox"),
  spreadMethod: keywords("pad", "reflect", "repeat"),
};

/**
 * Why `name="value"` is refused on the SVG element `tag`, or null when it is allowed as written.
 * Data attributes are allowed (the layer's name, hidden and locked flags among them).
 */
export function designSvgAttributeProblem(tag: string, name: string, value: string): string | null {
  if (/^data-[a-z0-9_.:-]+$/.test(name)) return null;
  if (/^on/i.test(name)) return "event handlers never run on the canvas";
  if (name.includes(":") || /^xml/i.test(name)) return "XML namespace attributes are not supported";
  const rule = Object.hasOwn(SVG_ATTRIBUTES, name) ? SVG_ATTRIBUTES[name] : undefined;
  if (!rule) return "is not a supported SVG attribute";
  return rule(value, tag);
}

/** The ID an SVG element renders with: unique to its SVG layer (`svgLayerId`) in the frame. */
export const designSvgScopedId = (svgLayerId: string, id: string) =>
  `${DESIGN_SVG_ID_PREFIX}${svgLayerId}.${id}`;

/**
 * An allowed SVG attribute value with its `id`, and every `url(#id)` or gradient `href`, moved
 * into one SVG's own scope (`scoped` maps a stored ID to the ID it gets there). Rendered with
 * `designSvgScopedId`, one SVG can never reach or shadow the definitions of another SVG, an
 * HTML layer or another frame.
 */
export function scopeDesignSvgAttribute(
  scoped: (id: string) => string,
  name: string,
  value: string,
): string {
  if (name === "id") return scoped(value.trim());
  if (name === "href") return `#${scoped(value.trim().slice(1))}`;
  if (name === "fill" || name === "stroke" || name === "clip-path" || name === "mask")
    return value.replace(
      FRAGMENT_URL,
      (_match, _quote: string, id: string) => `url(#${scoped(id)})`,
    );
  return value;
}

/** Whether an SVG layer paints with `currentColor`, so its `color` sets the icon's colour. */
export function designSvgUsesCurrentColor(tree: DesignLayerTree, svgLayerId: string): boolean {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    const node = nodes.get(id);
    if (node?.type !== "element" || seen.has(id)) return false;
    seen.add(id);
    return (
      Object.values(node.attributes).some((value) => /currentcolor/i.test(value)) ||
      node.children.some(visit)
    );
  };
  return visit(svgLayerId);
}
