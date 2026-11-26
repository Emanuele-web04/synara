// FILE: designCanvasCode.ts
// Purpose: "Copy as code" for canvas frames and layers, shared by the editor's copy
//          menu and the agents' code read tool: pure, no DOM, design content escaped.
// Exports: canvasNodeToReact, CanvasCodeFlavor

import { DESIGN_CANVAS_MAX_DEPTH, type DesignFrame, type DesignLayer } from "@synara/contracts";
import { declaredStyles, DESIGN_HTML_TAGS } from "./designCanvasLayers";
import { DESIGN_SVG_TAGS, DESIGN_SVG_TEXT_TAGS, scopeDesignSvgAttribute } from "./designCanvasSvg";
import { designTextBlockKind } from "./designCanvasText";

/** "Copy as code": React with inline styles (⌥R) or with Tailwind classes (⌥T). */
export type CanvasCodeFlavor = "css" | "tailwind";

type ElementLayer = Extract<DesignLayer, { type: "element" }>;
type Styles = Map<string, string>;
type Layout = "flex" | "block" | "inline";
/** `svg`: the ID scope of the inline SVG the children sit in; `parent` their element's tag. */
type ChildContext = { preserve: boolean; layout: Layout; svg?: string | null; parent?: string };

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

// --- JS literals: design content is untrusted, so every value is escaped for its position. ---

// With the `u` flag a surrogate range matches only unpaired halves; emoji pass through.
const LITERAL_ESCAPED = /[\\'"\p{Cc}\u2028\u2029\ud800-\udfff]/gu;
const ATTRIBUTE_UNSAFE = /["\\&\p{Cc}\u2028\u2029\ud800-\udfff]/u;
// JSX trims edge whitespace, decodes entities and rejects braces and angle brackets in text.
const TEXT_UNSAFE = /^\s|\s$|[{}<>&\p{Cc}\u2028\u2029\ud800-\udfff]|\/[/*]/u;
// Inside one line, between tags, JSX keeps spaces: only these need a string literal there.
const INLINE_TEXT_UNSAFE = /[{}<>&\p{Cc}\u2028\u2029\ud800-\udfff]|\/[/*]/u;
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** A one-line JS string literal, valid whatever the value contains. */
function jsString(value: string, quote: "'" | '"'): string {
  const body = value.replace(LITERAL_ESCAPED, (char) => {
    if (char === "'" || char === '"') return char === quote ? `\\${char}` : char;
    return own(SHORT_ESCAPES, char) ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `${quote}${body}${quote}`;
}

const jsxAttributeValue = (value: string) =>
  ATTRIBUTE_UNSAFE.test(value) ? `{${jsString(value, '"')}}` : `"${value}"`;

// --- Declarations and their cascade ---

const PROPERTY_NAME = /^(?:--[\w-]+|-?[a-z][a-z\d]*(?:-[a-z\d]+)*)$/;

/** Declarations as written, with `!important` dropped and multi-line values joined. */
function declarations(style: string | undefined): [string, string][] {
  if (!style) return [];
  return [...declaredStyles(style)].flatMap(([property, raw]): [string, string][] => {
    const value = raw
      .replace(/\s*!\s*important\s*$/i, "")
      .replace(/\s*[\n\r\f]\s*/g, " ")
      .trim();
    return PROPERTY_NAME.test(property) && value ? [[property, value]] : [];
  });
}

// Longhands a shorthand resets, where its name alone doesn't say.
const COVERED: Readonly<Record<string, RegExp>> = {
  inset: /^(?:top|right|bottom|left|inset-.+)$/,
  gap: /^(?:row|column)-gap$/,
  flex: /^flex-(?:grow|shrink|basis)$/,
  "flex-flow": /^flex-(?:direction|wrap)$/,
  font: /^(?:line-height|font-(?:family|size|style|weight|stretch|variant.*))$/,
  overflow: /^overflow-[xy]$/,
  outline: /^outline-(?:color|style|width)$/,
  columns: /^column-(?:width|count)$/,
  "place-items": /^(?:align|justify)-items$/,
  "place-content": /^(?:align|justify)-content$/,
  "place-self": /^(?:align|justify)-self$/,
  "border-radius": /^border-.+-radius$/,
  "border-width": /^border-.+-width$/,
  "border-style": /^border-.+-style$/,
  "border-color": /^border-.+-color$/,
};
// Shorthands that reset every `<name>-*` property (other than border radii and table borders).
const PREFIX_SHORTHANDS = new Set(
  "margin padding background background-position border border-top border-right border-bottom border-left border-block border-inline border-image margin-block margin-inline padding-block padding-inline inset-block inset-inline text-decoration transition animation grid-template grid-row grid-column list-style mask column-rule scroll-margin scroll-padding white-space font-variant".split(
    " ",
  ),
);

function covers(shorthand: string, longhand: string): boolean {
  if (shorthand === longhand) return false;
  const pattern = own(COVERED, shorthand);
  if (pattern) return pattern.test(longhand);
  return (
    PREFIX_SHORTHANDS.has(shorthand) &&
    longhand.startsWith(`${shorthand}-`) &&
    !/-(?:radius|collapse|spacing)$/.test(longhand)
  );
}

/** Last declaration wins, and a shorthand drops the longhands declared before it. */
function cascade(entries: Iterable<readonly [string, string]>): Styles {
  const styles: Styles = new Map();
  for (const [property, value] of entries) {
    styles.delete(property);
    for (const earlier of styles.keys()) if (covers(property, earlier)) styles.delete(earlier);
    styles.set(property, value);
  }
  return styles;
}

// --- React inline styles ---

// React appends `px` to bare numbers except on these.
const UNITLESS = new Set(
  "animation-iteration-count aspect-ratio column-count columns flex flex-grow flex-shrink font-weight grid-area grid-column grid-column-end grid-column-start grid-row grid-row-end grid-row-start line-clamp -webkit-line-clamp line-height opacity order orphans scale tab-size widows z-index zoom fill-opacity flood-opacity stop-opacity stroke-miterlimit stroke-opacity stroke-width".split(
    " ",
  ),
);
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** `font-size` → `fontSize`, `-webkit-x` → `WebkitX`, `-ms-x` → `msX`, `--x` → `'--x'`. */
function reactKey(property: string): string {
  if (property.startsWith("--")) return jsString(property, "'");
  const vendor = property.startsWith("-");
  const [first = "", ...rest] = property.slice(vendor ? 1 : 0).split("-");
  return (vendor && first !== "ms" ? capitalize(first) : first) + rest.map(capitalize).join("");
}

function reactValue(property: string, value: string): string {
  if (UNITLESS.has(property) && NUMBER.test(value)) {
    const number = String(Number(value));
    if (!/[^\d.-]/.test(number)) return number;
  }
  return jsString(value, "'");
}

const compareKeys = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Keys are alphabetical, except that a shorthand always comes before the longhands declared
 * after it: React applies them in key order, so `inset` after `bottom` would undo `bottom`.
 */
function styleObject(styles: ReadonlyMap<string, string>): string {
  const keys = new Map([...styles.keys()].map((property) => [property, reactKey(property)]));
  const sorted = [...keys.keys()].toSorted((a, b) => compareKeys(keys.get(a)!, keys.get(b)!));
  const ordered: string[] = [];
  const placed = new Set<string>();
  const place = (property: string) => {
    if (placed.has(property)) return;
    placed.add(property);
    for (const shorthand of sorted) if (covers(shorthand, property)) place(shorthand);
    ordered.push(property);
  };
  sorted.forEach(place);
  const entries = ordered.map(
    (property) => `${keys.get(property)}: ${reactValue(property, styles.get(property)!)}`,
  );
  return `{{ ${entries.join(", ")} }}`;
}

// --- Tailwind ---

/** Splits a value on top-level whitespace, keeping `calc(a + b)` whole. */
function splitValue(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value.trim()) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/** `[value]` with spaces as `_`, or null when it can't be one safe class token. */
function arbitrary(value: string): string | null {
  if (/[_[\]]/.test(value) || value.startsWith("--")) return null;
  const token = value
    .trim()
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, "_");
  if (!/^[\w#%.,()'+*/-]+$/.test(token) || (token.split("'").length - 1) % 2 !== 0) return null;
  let depth = 0;
  for (const char of token) {
    if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return null;
  }
  return depth === 0 ? `[${token}]` : null;
}

const prefixed = (prefix: string, token: string | null) => (token ? `${prefix}-${token}` : null);
const one = (name: string | null) => (name ? [name] : null);
const allConverted = (classes: readonly (string | null)[]) =>
  classes.every((name) => name !== null) ? (classes as string[]) : null;

const keywords = (prefix: string, values: string, aliases: Record<string, string> = {}) => ({
  ...Object.fromEntries(values.split(" ").map((value) => [value, `${prefix}${value}`])),
  ...aliases,
});

const KEYWORD_CLASSES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  display: keywords(
    "",
    "flex inline-flex grid inline-grid block inline-block inline contents flow-root table table-cell table-row list-item",
    { none: "hidden" },
  ),
  "flex-direction": {
    row: "flex-row",
    "row-reverse": "flex-row-reverse",
    column: "flex-col",
    "column-reverse": "flex-col-reverse",
  },
  "flex-wrap": keywords("flex-", "wrap nowrap wrap-reverse"),
  "align-items": keywords("items-", "start end center baseline stretch", {
    "flex-start": "items-start",
    "flex-end": "items-end",
  }),
  "justify-content": keywords("justify-", "start end center stretch normal", {
    "flex-start": "justify-start",
    "flex-end": "justify-end",
    "space-between": "justify-between",
    "space-around": "justify-around",
    "space-evenly": "justify-evenly",
  }),
  "align-content": keywords("content-", "start end center stretch normal baseline", {
    "flex-start": "content-start",
    "flex-end": "content-end",
    "space-between": "content-between",
    "space-around": "content-around",
    "space-evenly": "content-evenly",
  }),
  "align-self": keywords("self-", "auto start end center baseline stretch", {
    "flex-start": "self-start",
    "flex-end": "self-end",
  }),
  position: keywords("", "static relative absolute fixed sticky"),
  overflow: keywords("overflow-", "visible hidden clip scroll auto"),
  "overflow-x": keywords("overflow-x-", "visible hidden clip scroll auto"),
  "overflow-y": keywords("overflow-y-", "visible hidden clip scroll auto"),
  "text-align": keywords("text-", "left center right justify start end"),
  "vertical-align": keywords("align-", "baseline top middle bottom text-top text-bottom sub super"),
  "font-style": { italic: "italic", normal: "not-italic" },
  "object-fit": keywords("object-", "contain cover fill none scale-down"),
  "white-space": keywords("whitespace-", "normal nowrap pre pre-line pre-wrap break-spaces"),
  "text-transform": keywords("", "uppercase lowercase capitalize", { none: "normal-case" }),
  "text-decoration": keywords("", "underline overline line-through", { none: "no-underline" }),
  "text-decoration-line": keywords("", "underline overline line-through", {
    none: "no-underline",
  }),
  "text-overflow": { ellipsis: "text-ellipsis", clip: "text-clip" },
  "overflow-wrap": {
    anywhere: "wrap-anywhere",
    "break-word": "wrap-break-word",
    normal: "wrap-normal",
  },
  "box-sizing": { "border-box": "box-border", "content-box": "box-content" },
  "border-style": keywords("border-", "solid dashed dotted double hidden none"),
  visibility: { visible: "visible", hidden: "invisible", collapse: "collapse" },
  cursor: keywords(
    "cursor-",
    "auto default pointer wait text move help not-allowed none grab grabbing",
  ),
  "pointer-events": keywords("pointer-events-", "none auto"),
  "-webkit-font-smoothing": { antialiased: "antialiased", auto: "subpixel-antialiased" },
  "-moz-osx-font-smoothing": { grayscale: "antialiased", auto: "subpixel-antialiased" },
};

const LENGTH_KEYWORDS: Readonly<Record<string, string>> = {
  "0": "0",
  "0px": "0",
  auto: "auto",
  "100%": "full",
  "fit-content": "fit",
  "min-content": "min",
  "max-content": "max",
  none: "none",
};
const SIZE = new Set(["0", "auto", "full", "fit", "min", "max", "none"]);
const SPACE = new Set(["0", "auto"]);
const OFFSET = new Set(["0", "auto", "full"]);
const LENGTH_PREFIXES: Readonly<Record<string, readonly [string, ReadonlySet<string>]>> = {
  width: ["w", SIZE],
  height: ["h", SIZE],
  "min-width": ["min-w", SIZE],
  "max-width": ["max-w", SIZE],
  "min-height": ["min-h", SIZE],
  "max-height": ["max-h", SIZE],
  "flex-basis": ["basis", SIZE],
  "padding-top": ["pt", SPACE],
  "padding-right": ["pr", SPACE],
  "padding-bottom": ["pb", SPACE],
  "padding-left": ["pl", SPACE],
  "padding-inline": ["px", SPACE],
  "padding-block": ["py", SPACE],
  "padding-inline-start": ["ps", SPACE],
  "padding-inline-end": ["pe", SPACE],
  "margin-top": ["mt", SPACE],
  "margin-right": ["mr", SPACE],
  "margin-bottom": ["mb", SPACE],
  "margin-left": ["ml", SPACE],
  "margin-inline": ["mx", SPACE],
  "margin-block": ["my", SPACE],
  "margin-inline-start": ["ms", SPACE],
  "margin-inline-end": ["me", SPACE],
  "row-gap": ["gap-y", SPACE],
  "column-gap": ["gap-x", SPACE],
  top: ["top", OFFSET],
  right: ["right", OFFSET],
  bottom: ["bottom", OFFSET],
  left: ["left", OFFSET],
  "inset-inline": ["inset-x", OFFSET],
  "inset-block": ["inset-y", OFFSET],
};

function length(prefix: string, value: string, allowed: ReadonlySet<string>): string | null {
  const keyword = own(LENGTH_KEYWORDS, value.toLowerCase());
  if (keyword !== undefined && allowed.has(keyword)) return `${prefix}-${keyword}`;
  return prefixed(prefix, arbitrary(value));
}

type Sides = readonly [all: string, y: string | null, x: string | null, ...edges: string[]];
const PADDING: Sides = ["p", "py", "px", "pt", "pr", "pb", "pl"];
const MARGIN: Sides = ["m", "my", "mx", "mt", "mr", "mb", "ml"];
const INSET: Sides = ["inset", "inset-y", "inset-x", "top", "right", "bottom", "left"];
const BORDER: Sides = [
  "border",
  "border-y",
  "border-x",
  "border-t",
  "border-r",
  "border-b",
  "border-l",
];
const RADIUS: Sides = [
  "rounded",
  null,
  null,
  "rounded-tl",
  "rounded-tr",
  "rounded-br",
  "rounded-bl",
];

/** CSS 1–4 value box shorthands (top, right, bottom, left; or corners from top-left). */
function sides(
  value: string,
  [all, y, x, ...edges]: Sides,
  convert: (prefix: string, part: string) => string | null,
): string[] | null {
  const parts = splitValue(value);
  if (parts.length < 1 || parts.length > 4) return null;
  const [t = "", r = t, b = t, l = r] = parts;
  const pairs: [string, string][] =
    t === r && r === b && b === l
      ? [[all, t]]
      : y && x && t === b && r === l
        ? [
            [y, t],
            [x, r],
          ]
        : edges.map((prefix, index): [string, string] => [prefix, [t, r, b, l][index]!]);
  return allConverted(pairs.map(([prefix, part]) => convert(prefix, part)));
}

const PLAIN_COLOR = /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)|[a-z]+)$/i;
const COLOR_KEYWORDS: Readonly<Record<string, string>> = {
  transparent: "transparent",
  currentcolor: "current",
  inherit: "inherit",
  white: "white",
  black: "black",
};
const isColor = (value: string) =>
  PLAIN_COLOR.test(value) && !/^(?:initial|unset|revert|revert-layer|none|auto)$/i.test(value);

function color(prefix: string, value: string): string | null {
  if (!isColor(value)) return null;
  const keyword = own(COLOR_KEYWORDS, value.toLowerCase());
  return keyword ? `${prefix}-${keyword}` : prefixed(prefix, arbitrary(value));
}

const radius = (prefix: string, value: string) =>
  value === "0" || value === "0px" ? `${prefix}-none` : prefixed(prefix, arbitrary(value));
const borderWidth = (prefix: string, value: string) =>
  value === "0" || value === "0px" ? `${prefix}-0` : prefixed(prefix, arbitrary(value));

/**
 * `1px solid #e5e5e5` → width, style and color classes. Tailwind's preflight zeroes widths
 * and styles, so the declaration converts only with an explicit width and style.
 */
function border(prefix: string, value: string): string[] | null {
  if (/^(?:none|0|0px)$/i.test(value)) return [`${prefix}-0`];
  let width: string | null = null;
  let style: string | null = null;
  let tint: string | null = null;
  for (const part of splitValue(value)) {
    if (!style && /^(?:solid|dashed|dotted|double|hidden|none)$/i.test(part))
      style = part.toLowerCase();
    else if (!width && /^(?:[\d.]|calc\(|thin$|medium$|thick$)/i.test(part)) width = part;
    else if (!tint && isColor(part)) tint = part;
    else return null;
  }
  if (!width || !style) return null;
  if (style === "none" || style === "hidden") return [`${prefix}-0`];
  return allConverted([
    borderWidth(prefix, width),
    `border-${style}`,
    ...(tint ? [color(prefix, tint)] : []),
  ]);
}

const FONT_WEIGHTS: Readonly<Record<string, string>> = {
  "100": "font-thin",
  "200": "font-extralight",
  "300": "font-light",
  "400": "font-normal",
  normal: "font-normal",
  "500": "font-medium",
  "600": "font-semibold",
  "700": "font-bold",
  bold: "font-bold",
  "800": "font-extrabold",
  "900": "font-black",
};
const FLEX: Readonly<Record<string, string>> = {
  "1": "flex-1",
  "1 1 0": "flex-1",
  "1 1 0%": "flex-1",
  auto: "flex-auto",
  "1 1 auto": "flex-auto",
  none: "flex-none",
  "0 0 auto": "flex-none",
  initial: "flex-initial",
  "0 1 auto": "flex-initial",
};
const SIMPLE_LENGTH = /^(?:\d+\.?\d*|\.\d+)[a-z%]+$/i;
const CORNERS: Readonly<Record<string, string>> = {
  "border-top-left-radius": "rounded-tl",
  "border-top-right-radius": "rounded-tr",
  "border-bottom-right-radius": "rounded-br",
  "border-bottom-left-radius": "rounded-bl",
};
const BORDER_SIDES: Readonly<Record<string, string>> = {
  top: "border-t",
  right: "border-r",
  bottom: "border-b",
  left: "border-l",
};

function growShrink(name: "grow" | "shrink", value: string): string | null {
  if (value === "1") return name;
  if (value === "0") return `${name}-0`;
  return NUMBER.test(value) ? `${name}-[${value}]` : null;
}

/** Tailwind (v4) classes for one declaration, or null to keep it as an inline style. */
function tailwindClasses(property: string, value: string): readonly string[] | null {
  const keywordTable = own(KEYWORD_CLASSES, property);
  if (keywordTable) return one(own(keywordTable, value.toLowerCase()) ?? null);
  const lengthPrefix = own(LENGTH_PREFIXES, property);
  if (lengthPrefix) return one(length(lengthPrefix[0], value, lengthPrefix[1]));
  const corner = own(CORNERS, property);
  if (corner) return one(radius(corner, value));
  const side = /^border-(top|right|bottom|left)(?:-(width|color))?$/.exec(property);
  if (side) {
    const prefix = own(BORDER_SIDES, side[1]!)!;
    if (side[2] === "width") return one(borderWidth(prefix, value));
    return side[2] === "color" ? one(color(prefix, value)) : border(prefix, value);
  }
  switch (property) {
    case "padding":
      return sides(value, PADDING, (prefix, part) => length(prefix, part, SPACE));
    case "margin":
      return sides(value, MARGIN, (prefix, part) => length(prefix, part, SPACE));
    case "inset":
      return sides(value, INSET, (prefix, part) => length(prefix, part, OFFSET));
    case "gap": {
      const [row = "", column] = splitValue(value);
      if (column === undefined) return one(length("gap", row, SPACE));
      return allConverted([length("gap-y", row, SPACE), length("gap-x", column, SPACE)]);
    }
    case "border-radius":
      return value.includes("/") ? null : sides(value, RADIUS, radius);
    case "border":
      return border("border", value);
    case "border-width":
      return sides(value, BORDER, borderWidth);
    case "border-color":
      return sides(value, BORDER, color);
    case "background":
    case "background-color":
      return one(color("bg", value));
    case "color":
      return one(color("text", value));
    case "font-size":
      return SIMPLE_LENGTH.test(value) ? one(prefixed("text", arbitrary(value))) : null;
    case "font-weight":
      return one(
        own(FONT_WEIGHTS, value.toLowerCase()) ?? (/^\d+$/.test(value) ? `font-[${value}]` : null),
      );
    case "font-family": {
      // Double-quoted names become single-quoted so the class stays inside className="…".
      const families = value
        .split(",")
        .map((family) => family.trim().replace(/^"([^"']*)"$/, "'$1'"));
      return families.some((family) => family.includes('"'))
        ? null
        : one(prefixed("font", arbitrary(families.join(","))));
    }
    case "line-height":
      return one(prefixed("leading", arbitrary(value)));
    case "letter-spacing":
      return one(prefixed("tracking", arbitrary(value)));
    case "opacity":
      return /^(?:\d+\.?\d*|\.\d+)%?$/.test(value) ? [`opacity-[${value}]`] : null;
    case "z-index":
      if (value === "auto" || value === "0") return [`z-${value}`];
      return /^-?\d+$/.test(value) ? [`z-[${value}]`] : null;
    case "flex-grow":
      return one(growShrink("grow", value));
    case "flex-shrink":
      return one(growShrink("shrink", value));
    case "flex":
      return one(own(FLEX, splitValue(value).join(" ")) ?? prefixed("flex", arbitrary(value)));
    case "box-shadow":
      if (value === "none") return ["shadow-none"];
      return value.includes("var(") ? null : one(prefixed("shadow", arbitrary(value)));
    case "aspect-ratio":
      if (value === "auto") return ["aspect-auto"];
      return /^1(?:\s*\/\s*1)?$/.test(value)
        ? ["aspect-square"]
        : one(prefixed("aspect", arbitrary(value.replace(/\s*\/\s*/, "/"))));
    case "grid-template-columns":
      return one(value === "none" ? "grid-cols-none" : prefixed("grid-cols", arbitrary(value)));
    case "grid-template-rows":
      return one(value === "none" ? "grid-rows-none" : prefixed("grid-rows", arbitrary(value)));
    default:
      return null;
  }
}

/**
 * Classes in declaration order. A declaration that doesn't convert stays inline, and so do the
 * longhands declared after it: an inline shorthand would otherwise beat their classes.
 */
function tailwind(styles: Styles): { classes: string[]; inline: Styles } {
  const classes = new Set<string>();
  const inline: Styles = new Map();
  for (const [property, value] of styles) {
    const converted = [...inline.keys()].some((shorthand) => covers(shorthand, property))
      ? null
      : tailwindClasses(property, value);
    if (converted) for (const name of converted) classes.add(name);
    else inline.set(property, value);
  }
  return { classes: [...classes], inline };
}

// --- Elements ---

const VOID_TAGS = new Set("img input br hr meta link source area col embed track wbr".split(" "));
const BLOCK_TAGS = new Set(
  "div p h1 h2 h3 h4 h5 h6 main section article header footer nav aside ul ol li dl dt dd table thead tbody tfoot tr th td caption pre blockquote figure figcaption details summary hr form".split(
    " ",
  ),
);
const INLINE_TAGS = new Set(
  "span a b strong em i u s small sub sup mark label code abbr cite q time".split(" "),
);
// Text styles a copied layer inherited from the frame and its ancestors on the canvas.
const INHERITED = new Set(
  "color font font-family font-feature-settings font-size font-style font-variant font-weight letter-spacing line-height text-align text-shadow text-transform white-space word-spacing word-break overflow-wrap -webkit-font-smoothing -moz-osx-font-smoothing".split(
    " ",
  ),
);
const LAYER_ROOT_POSITIONING = /^(?:position|top|right|bottom|left|inset(?:-.+)?|z-index)$/;

// Styles and classes are written separately; the rest only mean something to the editor.
const SKIPPED_ATTRIBUTE = /^(?:style|class|data-name|data-hidden|data-locked|data-synara-.*)$/;
// Valid JSX in every toolchain: no namespaces (`a:b`) or dots.
const JSX_ATTRIBUTE_NAME = /^[A-Za-z_][\w-]*$/;
const REACT_RESERVED = /^(?:on|(?:ref|key|children|dangerouslysetinnerhtml)$)/i;
const REACT_ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  for: "htmlFor",
  tabindex: "tabIndex",
  colspan: "colSpan",
  rowspan: "rowSpan",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  contenteditable: "contentEditable",
  spellcheck: "spellCheck",
  srcset: "srcSet",
  crossorigin: "crossOrigin",
  inputmode: "inputMode",
  enterkeyhint: "enterKeyHint",
  accesskey: "accessKey",
  datetime: "dateTime",
};
// A static export of a form control: React warns about `value`/`checked` without a handler.
const UNCONTROLLED: Readonly<Record<string, string>> = {
  value: "defaultValue",
  checked: "defaultChecked",
};
const BOOLEAN_ATTRIBUTES = new Set(
  "checked disabled selected open hidden readonly required multiple autofocus novalidate reversed inert default".split(
    " ",
  ),
);

// SVG attributes React knows by a camelCase name; the rest are written as stored.
const REACT_SVG_NAMES = new Set(
  "clip-path clip-rule color-interpolation fill-opacity fill-rule paint-order shape-rendering stop-color stop-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width vector-effect".split(
    " ",
  ),
);
const camelCase = (name: string) =>
  name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());

/** A short, stable ID scope per exported SVG, so two copied icons never share a gradient ID. */
function svgCodeScope(layerId: string): (id: string) => string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < layerId.length; index++)
    hash = Math.imul(hash ^ layerId.charCodeAt(index), 0x01000193) >>> 0;
  const prefix = `s${hash.toString(36)}`;
  return (id) => `${prefix}-${id}`;
}

function jsxAttributes(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  svg: ((id: string) => string) | null,
): string[] {
  const result: string[] = [];
  for (const [name, stored] of Object.entries(attributes)) {
    if (SKIPPED_ATTRIBUTE.test(name) || !JSX_ATTRIBUTE_NAME.test(name) || REACT_RESERVED.test(name))
      continue;
    const lower = name.toLowerCase();
    if (svg) {
      const reactName = REACT_SVG_NAMES.has(name) ? camelCase(name) : name;
      result.push(`${reactName}=${jsxAttributeValue(scopeDesignSvgAttribute(svg, name, stored))}`);
      continue;
    }
    const raw = stored;
    const reactName =
      (["input", "textarea", "select"].includes(tag) ? own(UNCONTROLLED, lower) : undefined) ??
      own(REACT_ATTRIBUTE_NAMES, lower) ??
      name;
    if (BOOLEAN_ATTRIBUTES.has(lower)) result.push(reactName);
    else {
      // Base64 ignores whitespace; dropping it keeps image data on one line.
      const value = lower === "src" && raw.startsWith("data:") ? raw.replace(/\s+/g, "") : raw;
      result.push(`${reactName}=${jsxAttributeValue(value)}`);
    }
  }
  return result;
}

function layoutOf(tag: string, styles: ReadonlyMap<string, string>): Layout {
  const display = styles.get("display")?.toLowerCase();
  if (!display) return INLINE_TAGS.has(tag) ? "inline" : "block";
  if (/(?:^|[\s-])(?:flex|grid)$/.test(display)) return "flex";
  return display === "inline" || display === "contents" ? "inline" : "block";
}

/** Whitespace next to a block-level box is never rendered. */
function isBlockLevel(tag: string, styles: ReadonlyMap<string, string>): boolean {
  const display = styles.get("display")?.toLowerCase();
  if (!display) return BLOCK_TAGS.has(tag);
  return !display.startsWith("inline") && display !== "contents" && display !== "none";
}

function preserves(tag: string, styles: ReadonlyMap<string, string>, inherited: boolean): boolean {
  const mode = (styles.get("white-space-collapse") ?? styles.get("white-space"))?.toLowerCase();
  if (mode) return /pre|break-spaces/.test(mode);
  return inherited || tag === "pre" || tag === "textarea";
}

function rootExtras(styles: Styles, hasText: boolean): void {
  const extras: [string, string][] = [["box-sizing", "border-box"]];
  if (hasText)
    extras.push(
      ["-webkit-font-smoothing", "antialiased"],
      ["-moz-osx-font-smoothing", "grayscale"],
      ["font-synthesis", "none"],
      ["overflow-wrap", "anywhere"],
    );
  for (const [property, value] of extras)
    if (!styles.has(property) && !(property === "overflow-wrap" && styles.has("word-wrap")))
      styles.set(property, value);
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** One comment line: nothing in a title can end the comment or start a new line. */
const commentText = (text: string) =>
  text
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .replaceAll("*/", "*\\/");

/**
 * "Copy as React" for a frame or one layer: a component whose JSX reproduces the
 * canvas rendering, with styles inline (`css`) or as Tailwind classes with an inline fallback.
 */
export function canvasNodeToReact(input: {
  frame: Pick<DesignFrame, "width" | "height" | "style" | "layers">;
  /** null exports the whole frame (root = frame div); otherwise that layer's subtree. */
  layerId: string | null;
  flavor: CanvasCodeFlavor;
  /** For the header comment. */
  title: string;
  date: Date;
}): string {
  const { frame, layerId, flavor } = input;
  const nodes = new Map(frame.layers.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string>();
  for (const node of frame.layers.nodes)
    if (node.type === "element") for (const child of node.children) parents.set(child, node.id);
  const declared = new Map<string, [string, string][]>();
  const declarationsOf = (node: ElementLayer) => {
    let result = declared.get(node.id);
    if (!result) declared.set(node.id, (result = declarations(node.attributes.style)));
    return result;
  };
  const renderable = (node: ElementLayer) =>
    DESIGN_HTML_TAGS.has(node.tag) || DESIGN_SVG_TAGS.has(node.tag);
  const visible = (node: ElementLayer) =>
    renderable(node) && node.attributes["data-hidden"] !== "true";

  const hasText = (ids: readonly string[]) => {
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      const node = nodes.get(id);
      if (!node || seen.has(id)) return false;
      seen.add(id);
      if (node.type === "text") return node.text.trim() !== "";
      // An SVG's title and description are not text on the page.
      return visible(node) && node.tag !== "svg" && node.children.some(visit);
    };
    return ids.some(visit);
  };

  /** An element's opening tag, without its closing `>`. */
  const opening = (
    tag: string,
    attributes: Readonly<Record<string, string>>,
    styles: Styles,
    svg: ((id: string) => string) | null = null,
  ): string => {
    const { classes, inline } =
      flavor === "tailwind" ? tailwind(styles) : { classes: [], inline: styles };
    const className = [...(attributes.class?.split(/\s+/) ?? []), ...classes].filter(Boolean);
    const parts = [
      tag,
      ...(className.length > 0 ? [`className=${jsxAttributeValue(className.join(" "))}`] : []),
      ...jsxAttributes(tag, attributes, svg),
      ...(inline.size > 0 ? [`style=${styleObject(inline)}`] : []),
    ];
    return `<${parts.join(" ")}`;
  };
  const element = (
    tag: string,
    attributes: Readonly<Record<string, string>>,
    styles: Styles,
    body: readonly string[],
    svg: ((id: string) => string) | null = null,
  ): string[] => {
    const open = opening(tag, attributes, styles, svg);
    if (body.length === 0) return [`${open} />`];
    return [`${open}>`, ...body.map((line) => `  ${line}`), `</${tag}>`];
  };

  const visited = new Set<string>();

  const text = (
    raw: string,
    context: ChildContext,
    before: ElementLayer | string | undefined,
    after: ElementLayer | string | undefined,
  ): string[] => {
    // HTML collapsing; trimmed only where the browser wouldn't render the space either.
    const edge = (neighbor: ElementLayer | string | undefined) =>
      context.layout === "flex" ||
      (neighbor === undefined
        ? context.layout === "block"
        : typeof neighbor !== "string" &&
          isBlockLevel(neighbor.tag, new Map(declarationsOf(neighbor))));
    let value = raw;
    if (!context.preserve) {
      value = value.replace(/[ \t\n\r\f]+/g, " ");
      if (edge(before)) value = value.replace(/^ /, "");
      if (edge(after)) value = value.replace(/ $/, "");
    } else if (context.layout === "flex" && /^[ \t\n\r\f]*$/.test(value)) value = "";
    if (!value) return [];
    return [TEXT_UNSAFE.test(value) ? `{${jsString(value, '"')}}` : value];
  };

  const children = (ids: readonly string[], context: ChildContext, depth: number): string[] => {
    if (depth > DESIGN_CANVAS_MAX_DEPTH) return [];
    // Adjacent text runs merge, as hidden layers between them don't render.
    const items: (ElementLayer | string)[] = [];
    for (const id of ids) {
      const node = nodes.get(id);
      if (!node || visited.has(id)) continue;
      visited.add(id);
      const last = items.at(-1);
      // Inside an SVG only its title and description hold text.
      if (node.type === "text" && context.svg && !DESIGN_SVG_TEXT_TAGS.has(context.parent ?? ""))
        continue;
      if (node.type === "text") {
        if (typeof last === "string") items[items.length - 1] = last + node.text;
        else items.push(node.text);
      } else if (visible(node)) items.push(node);
    }
    return items.flatMap((item, index) =>
      typeof item === "string"
        ? text(item, context, items[index - 1], items[index + 1])
        : layer(item, cascade(declarationsOf(item)), context.preserve, depth, context.svg),
    );
  };

  /**
   * A text with styled spans (`@synara/shared/designCanvasText`) reads as one line of JSX, as
   * the sentence it is: `Ship <span style={…}>twice as fast</span> today`. Spaces between
   * tags stay as written; text at the line's edges that starts or ends with one, or holds what
   * JSX would read as markup, becomes a string literal.
   */
  const richText = (node: ElementLayer, preserve: boolean): string | null => {
    if (designTextBlockKind(nodes, node.id) !== "rich") return null;
    const collapse = (value: string) => (preserve ? value : value.replace(/[ \t\n\r\f]+/g, " "));
    const literal = (value: string, edgeStart: boolean, edgeEnd: boolean) =>
      INLINE_TEXT_UNSAFE.test(value) ||
      (edgeStart && /^\s/.test(value)) ||
      (edgeEnd && /\s$/.test(value))
        ? `{${jsString(value, '"')}}`
        : value;
    const items: (string | ElementLayer)[] = [];
    for (const id of node.children) {
      const child = nodes.get(id);
      if (!child || visited.has(id)) continue;
      visited.add(id);
      const last = items.at(-1);
      if (child.type === "text") {
        if (typeof last === "string") items[items.length - 1] = last + child.text;
        else items.push(child.text);
      } else items.push(child);
    }
    const parts = items.flatMap((item, index) => {
      const first = index === 0;
      const end = index === items.length - 1;
      if (typeof item !== "string") {
        const inner = collapse(
          item.children
            .map((id) => {
              visited.add(id);
              const child = nodes.get(id);
              return child?.type === "text" ? child.text : "";
            })
            .join(""),
        );
        const open = opening(item.tag, item.attributes, cascade(declarationsOf(item)));
        return [inner ? `${open}>${literal(inner, false, false)}</${item.tag}>` : `${open} />`];
      }
      let value = collapse(item);
      // A block's own edges render no space, as the browser lays it out.
      if (!preserve && first) value = value.replace(/^ /, "");
      if (!preserve && end) value = value.replace(/ $/, "");
      return value ? [literal(value, first, end)] : [];
    });
    return parts.join("");
  };

  const scopes = new Map<string, (id: string) => string>();

  const layer = (
    node: ElementLayer,
    styles: Styles,
    inheritedPreserve: boolean,
    depth: number,
    svg: string | null = null,
  ): string[] => {
    // An inline SVG's IDs are scoped to it, as on the canvas; its descendants share its scope.
    const scope = svg ?? (node.tag === "svg" ? node.id : null);
    const context = {
      preserve: preserves(node.tag, styles, inheritedPreserve),
      layout: layoutOf(node.tag, styles),
      svg: scope,
      parent: node.tag,
    };
    const rich = scope === null ? richText(node, context.preserve) : null;
    const body =
      rich !== null
        ? rich
          ? [rich]
          : []
        : VOID_TAGS.has(node.tag)
          ? []
          : children(node.children, context, depth + 1);
    let scoped: ((id: string) => string) | null = null;
    if (scope !== null) {
      scoped = scopes.get(scope) ?? svgCodeScope(scope);
      scopes.set(scope, scoped);
    }
    return element(node.tag, node.attributes, styles, body, scoped);
  };

  const frameDeclarations = declarations(frame.style);
  const exportFrame = (): string[] => {
    const styles = cascade([
      ["width", `${frame.width}px`],
      ["height", `${frame.height}px`],
      ...frameDeclarations.filter(([property]) => property !== "width" && property !== "height"),
    ]);
    // What DESIGN_FRAME_BASE_CSS gives every frame root.
    if (!styles.has("position")) styles.set("position", "relative");
    if (!["overflow", "overflow-x", "overflow-y"].some((property) => styles.has(property)))
      styles.set("overflow", "hidden");
    if (!styles.has("background") && !styles.has("background-color"))
      styles.set("background-color", "#fff");
    rootExtras(styles, hasText(frame.layers.roots));
    const context = { preserve: preserves("div", styles, false), layout: layoutOf("div", styles) };
    return element("div", {}, styles, children(frame.layers.roots, context, 0));
  };

  const exportLayer = (node: DesignLayer): string[] | null => {
    visited.add(node.id);
    if (node.type === "text") {
      const lines = text(node.text, { preserve: false, layout: "block" }, undefined, undefined);
      return lines.length > 0 ? ["<>", ...lines.map((line) => `  ${line}`), "</>"] : null;
    }
    if (!renderable(node)) return null;
    const ancestors: ElementLayer[] = [];
    for (let id = parents.get(node.id); id && ancestors.length <= DESIGN_CANVAS_MAX_DEPTH; ) {
      const parent = nodes.get(id);
      if (parent?.type !== "element") break;
      ancestors.unshift(parent);
      id = parents.get(id);
    }
    // Children, not the layer itself: an explicitly copied hidden layer is still exported.
    const subtreeHasText = hasText(node.children);
    // Pasted elsewhere, the layer no longer inherits the frame's text styles, so carry them.
    const inherited = subtreeHasText
      ? [frameDeclarations, ...ancestors.map(declarationsOf)]
          .flat()
          .filter(([property]) => INHERITED.has(property))
      : [];
    const styles = cascade([...inherited, ...declarationsOf(node)]);
    // The layer is now the component's root: drop where it sat in its old parent.
    for (const property of styles.keys())
      if (LAYER_ROOT_POSITIONING.test(property)) styles.delete(property);
    rootExtras(styles, subtreeHasText);
    const inheritedPreserve = ancestors.reduce(
      (preserve, ancestor) => preserves(ancestor.tag, new Map(declarationsOf(ancestor)), preserve),
      preserves("div", new Map(frameDeclarations), false),
    );
    // A shape copied from inside an SVG keeps that SVG's ID scope and attribute names.
    const svgRoot = ancestors.find((ancestor) => ancestor.tag === "svg")?.id ?? null;
    return layer(node, styles, inheritedPreserve, 0, svgRoot);
  };

  const target = layerId === null ? undefined : nodes.get(layerId);
  const lines = layerId === null ? exportFrame() : target ? exportLayer(target) : null;
  const header = [
    "/**",
    ` * ${["From Synara canvas", commentText(input.title)].filter(Boolean).join(": ")}`,
    ...(Number.isNaN(input.date.getTime())
      ? []
      : [
          ` * ${MONTHS[input.date.getMonth()]} ${input.date.getDate()}, ${input.date.getFullYear()}`,
        ]),
    " */",
  ];
  const body = lines
    ? ["  return (", ...lines.map((line) => `    ${line}`), "  );"]
    : ["  return null;"];
  return [...header, "export default function () {", ...body, "}"].join("\n");
}
