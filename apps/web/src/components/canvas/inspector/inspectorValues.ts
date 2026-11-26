// FILE: inspectorValues.ts
// Purpose: Pure parsing and mapping rules behind the canvas inspector: CSS value input,
//          mixed values, sizing modes, the flex alignment grid, shadows, colors and fonts.
// Layer: Canvas editor logic (no DOM)

export type StylePatch = Record<string, string | null>;

/** A value that differs across the selection. Fields render it as "–". */
export const MIXED = Symbol("mixed");
export type Mixed = typeof MIXED;
export type MaybeMixed<T> = T | Mixed;

/** The shared value, MIXED when they differ, or undefined for an empty list. */
export function mergeValues<T>(
  values: readonly T[],
  equals: (a: T, b: T) => boolean = Object.is,
): MaybeMixed<T> | undefined {
  if (values.length === 0) return undefined;
  const first = values[0]!;
  return values.every((value) => equals(first, value)) ? first : MIXED;
}

export const isMixed = (value: unknown): value is Mixed => value === MIXED;

/** Number field props for a merged number; NaN (a per-element mismatch) also counts as mixed. */
export function mixedNumber(value: MaybeMixed<number> | undefined): {
  value: number | null;
  mixed: boolean;
} {
  if (value === undefined) return { value: null, mixed: false };
  if (isMixed(value) || Number.isNaN(value)) return { value: null, mixed: true };
  return { value, mixed: false };
}

/** A merged value for selects and toggles: null when mixed or empty. */
export const single = <T>(value: MaybeMixed<T> | undefined): T | null =>
  value === undefined || isMixed(value) ? null : value;

// ── Inline declarations ──────────────────────────────────────────────────

export type Declaration = { property: string; value: string; important: boolean };

/** Splits `text` on `separator` outside parentheses and quotes. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === separator) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Declarations of one stored inline style, in source order. */
export function parseInlineStyle(style: string | undefined): Declaration[] {
  if (!style) return [];
  const declarations: Declaration[] = [];
  for (const part of splitTopLevel(style, ";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const rawProperty = part.slice(0, colon).trim();
    if (!/^(?:--[\w-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/.test(rawProperty)) continue;
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    if (!value) continue;
    const property = rawProperty.startsWith("--") ? rawProperty : rawProperty.toLowerCase();
    declarations.push({ property, value, important });
  }
  return declarations;
}

/** Last declared value per property, the one that wins in the cascade. */
export function declaredValues(declarations: readonly Declaration[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const declaration of declarations) values.set(declaration.property, declaration.value);
  return values;
}

/** Properties with a dedicated inspector control; everything else is listed under Other styles. */
const HANDLED_PROPERTIES = new Set([
  "width",
  "height",
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "inset",
  "rotate",
  "overflow",
  "overflow-x",
  "overflow-y",
  "display",
  "flex",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "flex-direction",
  "flex-wrap",
  "flex-flow",
  "justify-content",
  "align-items",
  "gap",
  "row-gap",
  "column-gap",
  "opacity",
  "mix-blend-mode",
  "font",
  "font-family",
  "font-weight",
  "font-size",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "text-wrap-mode",
  "text-wrap-style",
  "word-break",
  "text-overflow",
  "-webkit-line-clamp",
  "-webkit-box-orient",
  "line-clamp",
  "align-content",
  "paint-order",
  "box-shadow",
  "text-shadow",
  "filter",
  "backdrop-filter",
  "-webkit-backdrop-filter",
]);
const HANDLED_PREFIXES = [
  "padding",
  "background",
  "border",
  "outline",
  "text-decoration",
  "-webkit-text-stroke",
];

export function isHandledProperty(property: string): boolean {
  if (HANDLED_PROPERTIES.has(property)) return true;
  return HANDLED_PREFIXES.some(
    (prefix) => property === prefix || property.startsWith(`${prefix}-`),
  );
}

// ── Number and unit input ────────────────────────────────────────────────

export type CssInput =
  | { kind: "length"; value: number; unit: string }
  | { kind: "keyword"; keyword: string };

const INPUT_KEYWORDS = new Set([
  "auto",
  "fit",
  "hug",
  "fill",
  "normal",
  "none",
  "fit-content",
  "max-content",
  "min-content",
]);
const INPUT_UNITS = new Set(["px", "%", "em", "rem", "deg", "pt", "ch", "ex", "vh", "vw", "x"]);

/**
 * Parses what a user typed into a number field: "12", "12px", "50 %", "1.2em", "auto", or
 * arithmetic such as "24*2", "(100-8)/2" or "16px+4px" (one unit at most).
 * A bare number takes `defaultUnit` (empty for unitless properties such as opacity).
 */
export function parseCssInput(text: string, defaultUnit: string): CssInput | null {
  const value = text.trim().toLowerCase().replace(/,/g, ".");
  if (!value) return null;
  if (INPUT_KEYWORDS.has(value)) return { kind: "keyword", keyword: value };
  const match = /^([-+]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)$/.exec(value);
  if (!match) return parseExpressionInput(value, defaultUnit);
  const number = Number(match[1]);
  const unit = match[2] ?? "";
  if (!Number.isFinite(number)) return null;
  if (unit && !INPUT_UNITS.has(unit)) return null;
  return { kind: "length", value: number, unit: unit || defaultUnit };
}

/** A unit written right after a number ("16px", "50 %"). */
const EXPRESSION_UNIT = /(?<=[\d.])\s*([a-z%]+)/g;

function parseExpressionInput(value: string, defaultUnit: string): CssInput | null {
  if (value.length > 80) return null;
  const units = new Set([...value.matchAll(EXPRESSION_UNIT)].map((match) => match[1]!));
  if (units.size > 1) return null;
  const [unit = ""] = units;
  if (unit && !INPUT_UNITS.has(unit)) return null;
  const result = evaluateArithmetic(value.replace(EXPRESSION_UNIT, ""));
  return result === null ? null : { kind: "length", value: result, unit: unit || defaultUnit };
}

/**
 * Evaluates `+ - * /` and parentheses over plain numbers, with the usual precedence. Anything
 * else (names, functions, a stray operator) is not an expression: null, never `eval`.
 */
export function evaluateArithmetic(text: string): number | null {
  const source = text.replace(/\s+/g, "");
  if (!source) return null;
  let index = 0;
  let depth = 0;
  const peek = () => source[index];
  const number = (): number | null => {
    const match = /^(?:\d+\.?\d*|\.\d+)/.exec(source.slice(index));
    if (!match) return null;
    index += match[0].length;
    return Number(match[0]);
  };
  const factor = (): number | null => {
    const char = peek();
    if (char === "+" || char === "-") {
      index++;
      const value = factor();
      return value === null ? null : char === "-" ? -value : value;
    }
    if (char === "(") {
      if (++depth > 16) return null;
      index++;
      const value = sum();
      if (value === null || peek() !== ")") return null;
      index++;
      depth--;
      return value;
    }
    return number();
  };
  const product = (): number | null => {
    let value = factor();
    while (value !== null && (peek() === "*" || peek() === "/")) {
      const operator = source[index++];
      const right = factor();
      if (right === null) return null;
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };
  const sum = (): number | null => {
    let value = product();
    while (value !== null && (peek() === "+" || peek() === "-")) {
      const operator = source[index++];
      const right = product();
      if (right === null) return null;
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = sum();
  return result !== null && index === source.length && Number.isFinite(result) ? result : null;
}

/** Arrow and scrub steps: 1, or 8 with Shift; fractional steps grow tenfold. */
export const largeStepFor = (step: number) => (step >= 1 ? step * 8 : step * 10);

/** Compact number text: at most `decimals` places, no trailing zeros, no "-0". */
export function formatNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return "";
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export const formatLength = (value: number, unit: string) => `${formatNumber(value)}${unit}`;

/** A px length ("12px", "12", "0") as a number; null for anything else. */
export function parsePx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+))(px)?\s*$/i.exec(value);
  return match ? Number(match[1]) : null;
}

/** A percent length, including the `round(50%, 1px)` form stored layouts use. */
export function parsePercent(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(?:round\(\s*)?(-?(?:\d+\.?\d*|\.\d+))%/i.exec(value);
  return match ? Number(match[1]) : null;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// ── Sizing modes ─────────────────────────────────────────────────────────

export type SizingAxis = "width" | "height";
export type SizingMode = "fixed" | "fit" | "fill" | "relative";

export type SizingContext = {
  axis: SizingAxis;
  /** The stored inline value of `width`/`height`, if any. */
  declared: string | undefined;
  /** Computed values of the element. */
  display: string;
  position: string;
  flexGrow: number;
  alignSelf: string;
  /** Computed values of the parent element; null for a frame's top level. */
  parent: { display: string; direction: string; alignItems: string } | null;
};

const isFlex = (display: string) => display === "flex" || display === "inline-flex";
const isGrid = (display: string) => display === "grid" || display === "inline-grid";

/** True when the parent is a flex container whose main axis is `axis`. */
export function isFlexMainAxis(axis: SizingAxis, parent: SizingContext["parent"]): boolean {
  if (!parent || !isFlex(parent.display)) return false;
  const row = !parent.direction.startsWith("column");
  return axis === "width" ? row : !row;
}

/** How the element sizes along `axis`: fixed, fit or fill. */
export function readSizingMode(context: SizingContext): SizingMode {
  const { axis, parent } = context;
  const mainAxis = isFlexMainAxis(axis, parent);
  if (mainAxis && context.flexGrow > 0) return "fill";
  const declared = context.declared?.trim().toLowerCase();
  if (declared && declared !== "auto") {
    const percent = parsePercent(declared);
    if (percent !== null) return percent === 100 && !mainAxis ? "fill" : "relative";
    if (/^(?:fit-content|max-content|min-content)/.test(declared)) return "fit";
    if (/^(?:stretch|-webkit-fill-available|-moz-available)$/.test(declared)) return "fill";
    return "fixed";
  }
  if (context.position === "absolute" || context.position === "fixed") return "fit";
  if (parent && isFlex(parent.display)) {
    if (mainAxis) return "fit";
    const align =
      context.alignSelf === "auto" || context.alignSelf === "normal"
        ? parent.alignItems
        : context.alignSelf;
    return align === "stretch" || align === "normal" ? "fill" : "fit";
  }
  if (parent && isGrid(parent.display)) return "fill";
  if (axis === "height") return "fit";
  return context.display.startsWith("inline") || context.display === "none" ? "fit" : "fill";
}

/**
 * The patch that switches `axis` to `mode`. `size` and `parentSize` are the current layout
 * sizes in px, used to keep the element where it is when it becomes fixed or relative.
 */
export function sizingPatch(input: {
  axis: SizingAxis;
  mode: SizingMode;
  size: number;
  parentSize: number;
  parent: SizingContext["parent"];
  /** The mode the element has now; leaving Fill in a flex parent clears the flex shorthand. */
  current: SizingMode;
  /** An explicit amount: px for Fixed, percent for Relative. Defaults to the current size. */
  value?: number | undefined;
}): StylePatch {
  const { axis, mode } = input;
  const mainAxis = isFlexMainAxis(axis, input.parent);
  const patch: StylePatch = {};
  if (mainAxis && input.current === "fill" && mode !== "fill")
    Object.assign(patch, { flex: null, "flex-grow": null, "flex-basis": null });
  switch (mode) {
    case "fixed":
      patch[axis] = `${formatNumber(Math.max(0, input.value ?? Math.round(input.size)))}px`;
      if (mainAxis) patch["flex-shrink"] = "0";
      break;
    case "fit":
      patch[axis] = "fit-content";
      break;
    case "fill":
      if (mainAxis)
        Object.assign(patch, {
          "flex-grow": null,
          "flex-basis": null,
          flex: "1 1 0px",
          [axis]: null,
        });
      else patch[axis] = "100%";
      break;
    case "relative": {
      const percent =
        input.value ?? (input.parentSize > 0 ? (input.size / input.parentSize) * 100 : 100);
      patch[axis] = `${formatNumber(Math.max(0, percent), 1)}%`;
      break;
    }
  }
  return patch;
}

// ── Flex alignment grid ──────────────────────────────────────────────────

export type GridPosition = "start" | "center" | "end";
export type AlignmentState = {
  /**
   * Horizontal and vertical position. "spread" is space-between along that axis; "baseline"
   * is baseline alignment on the cross axis (the pad's two variants).
   */
  x: GridPosition | "spread" | "baseline";
  y: GridPosition | "spread" | "baseline";
};

function normalizeJustify(value: string): GridPosition | "spread" {
  if (value.startsWith("space-")) return "spread";
  if (value === "center") return "center";
  if (/(?:^|-)(?:end|right)$/.test(value)) return "end";
  return "start";
}

function normalizeAlign(value: string): GridPosition | "baseline" {
  if (value.includes("baseline")) return "baseline";
  if (value === "center") return "center";
  if (/(?:^|-)end$/.test(value)) return "end";
  return "start";
}

/** Grid cell for the current justify-content/align-items, by direction. */
export function readAlignment(input: {
  direction: string;
  justifyContent: string;
  alignItems: string;
}): AlignmentState {
  const main = normalizeJustify(input.justifyContent);
  const cross = normalizeAlign(input.alignItems);
  return input.direction.startsWith("column") ? { x: cross, y: main } : { x: main, y: cross };
}

const toFlexValue = (position: GridPosition) =>
  position === "center" ? "center" : position === "end" ? "flex-end" : "flex-start";

/**
 * Patch for clicking grid cell (x, y). Space-between stays on and only the cross axis moves;
 * baseline stays on and only the main axis moves.
 */
export function alignmentPatch(
  direction: string,
  cell: { x: GridPosition; y: GridPosition },
  current: AlignmentState,
): StylePatch {
  const column = direction.startsWith("column");
  const main = column ? cell.y : cell.x;
  const cross = column ? cell.x : cell.y;
  const spread = (column ? current.y : current.x) === "spread";
  const baseline = (column ? current.x : current.y) === "baseline";
  return {
    ...(spread ? {} : { "justify-content": toFlexValue(main) }),
    ...(baseline ? {} : { "align-items": toFlexValue(cross) }),
  };
}

const onAxis = (state: AlignmentState["x"], position: GridPosition) =>
  state === "spread" || state === "baseline" || state === position;

/** Whether a grid cell is highlighted for the current alignment. */
export function isAlignmentCell(state: AlignmentState, x: GridPosition, y: GridPosition) {
  return onAxis(state.x, x) && onAxis(state.y, y);
}

// ── Colors ───────────────────────────────────────────────────────────────

export type Rgba = { r: number; g: number; b: number; a: number };

const channel = (text: string, scale: number) => {
  const value = text.trim();
  if (value.endsWith("%")) return (Number(value.slice(0, -1)) / 100) * scale;
  if (value === "none") return 0;
  return Number(value);
};

/** Hex, rgb()/rgba() (comma or space syntax), color(srgb …) and transparent; null otherwise. */
export function parseCssColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
    const read = (at: number) => parseInt(digits.slice(at, at + 2), 16);
    return { r: read(0), g: read(2), b: read(4), a: digits.length === 8 ? read(6) / 255 : 1 };
  }
  const rgb = /^rgba?\((.*)\)$/.exec(text);
  if (rgb) {
    const [colors, alpha] = rgb[1]!.split("/");
    const parts = colors!.includes(",") ? colors!.split(",") : colors!.trim().split(/\s+/);
    const alphaText = alpha ?? (parts.length === 4 ? parts.pop() : undefined);
    if (parts.length !== 3) return null;
    const [r, g, b] = parts.map((part) => channel(part, 255));
    const a = alphaText === undefined ? 1 : channel(alphaText, 1);
    if ([r, g, b, a].some((value) => !Number.isFinite(value))) return null;
    return {
      r: Math.round(clamp(r!, 0, 255)),
      g: Math.round(clamp(g!, 0, 255)),
      b: Math.round(clamp(b!, 0, 255)),
      a: clamp(a, 0, 1),
    };
  }
  const srgb = /^color\(\s*srgb\s+([^/)]+)(?:\/\s*([^)]+))?\)$/.exec(text);
  if (srgb) {
    const parts = srgb[1]!
      .trim()
      .split(/\s+/)
      .map((part) => channel(part, 1));
    if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return null;
    const a = srgb[2] === undefined ? 1 : channel(srgb[2], 1);
    const [r, g, b] = parts.map((value) => Math.round(clamp(value, 0, 1) * 255));
    return { r: r!, g: g!, b: b!, a: Number.isFinite(a) ? clamp(a, 0, 1) : 1 };
  }
  return null;
}

const hexByte = (value: number) =>
  Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

/** Six-digit hex without "#", as the inspector shows it. */
export const formatHex = (color: Rgba) =>
  `${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;

/** The CSS value written for a color: #RRGGBB, or #RRGGBBAA when translucent. */
export function toCssColor(color: Rgba): string {
  const alpha = Math.round(clamp(color.a, 0, 1) * 255);
  return `#${formatHex(color)}${alpha === 255 ? "" : hexByte(alpha)}`;
}

export const sameColor = (a: Rgba, b: Rgba) =>
  a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 0.005;

// ── Shadows ──────────────────────────────────────────────────────────────

export type Shadow = {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  inset: boolean;
};

export const DEFAULT_SHADOW: Shadow = {
  x: 0,
  y: 4,
  blur: 12,
  spread: 0,
  color: "#00000040",
  inset: false,
};

/** Box shadows in computed (`rgba(…) 0px 4px 12px 0px`) or authored order. */
export function parseBoxShadow(value: string | undefined): Shadow[] {
  if (!value || value.trim() === "none") return [];
  const shadows: Shadow[] = [];
  for (const layer of splitTopLevel(value, ",")) {
    const tokens = splitTopLevel(layer.trim(), " ").filter(Boolean);
    const lengths: number[] = [];
    let color = "#000000";
    let inset = false;
    for (const token of tokens) {
      if (token.toLowerCase() === "inset") inset = true;
      else if (/^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/i.test(token)) lengths.push(parseFloat(token));
      else color = token;
    }
    if (lengths.length < 2) continue;
    shadows.push({
      x: lengths[0]!,
      y: lengths[1]!,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color,
      inset,
    });
  }
  return shadows;
}

export function formatBoxShadow(shadows: readonly Shadow[]): string | null {
  if (shadows.length === 0) return null;
  return shadows
    .map((shadow) =>
      [
        shadow.inset ? "inset" : null,
        `${formatNumber(shadow.x)}px`,
        `${formatNumber(shadow.y)}px`,
        `${formatNumber(shadow.blur)}px`,
        `${formatNumber(shadow.spread)}px`,
        shadow.color,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(", ");
}

// ── Fonts ────────────────────────────────────────────────────────────────

/** Mirrors `registeredFontFamily` in lib/designCanvas: work fonts render under this prefix. */
const REGISTERED_FONT_PREFIX = "SynaraCanvas ";
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "-apple-system",
]);

/** The family a computed `font-family` resolves first, as designs name it. */
export function primaryFontFamily(value: string | undefined): string {
  const first = splitTopLevel(value ?? "", ",")[0]?.trim() ?? "";
  const name = first.replace(/^["']|["']$/g, "").trim();
  return name.startsWith(REGISTERED_FONT_PREFIX) ? name.slice(REGISTERED_FONT_PREFIX.length) : name;
}

/** Generic fallback for a catalog category ("sans-serif", "serif", "display", …). */
export function fontFallback(category: string | undefined): string {
  switch (category?.toLowerCase()) {
    case "serif":
      return "serif";
    case "monospace":
      return "monospace";
    case "handwriting":
      return "cursive";
    default:
      return "sans-serif";
  }
}

/** The `font-family` value written for a picked family. */
export function fontFamilyValue(family: string, category?: string): string {
  if (GENERIC_FAMILIES.has(family.toLowerCase())) return family;
  return `"${family.replace(/["\\]/g, "")}", ${fontFallback(category)}`;
}

/** Weights to offer: catalog weights, or every hundred inside a variable range. */
export function fontWeightOptions(
  family: { weights: readonly number[]; variable: boolean } | undefined,
): number[] {
  const all = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  if (!family || family.weights.length === 0) return all;
  if (family.variable && family.weights.length >= 2) {
    const min = Math.min(...family.weights);
    const max = Math.max(...family.weights);
    return all.filter((weight) => weight >= min && weight <= max);
  }
  return [...new Set(family.weights)].toSorted((a, b) => a - b);
}

/** Case-insensitive search that prefers prefix matches, then word starts, then substrings. */
export function searchFamilies<T extends { family: string }>(
  families: readonly T[],
  query: string,
  limit: number,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return families.slice(0, limit);
  const ranked: Array<[number, T]> = [];
  for (const family of families) {
    const name = family.family.toLowerCase();
    const at = name.indexOf(needle);
    if (at < 0) continue;
    const rank = at === 0 ? 0 : name[at - 1] === " " ? 1 : 2;
    ranked.push([rank, family]);
  }
  return ranked
    .toSorted((a, b) => a[0] - b[0] || a[1].family.localeCompare(b[1].family))
    .slice(0, limit)
    .map(([, family]) => family);
}

// ── Sides and corners ────────────────────────────────────────────────────

export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];
export const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;
export type Corner = (typeof CORNERS)[number];

/** Which sides carry a border: all, exactly one, none, or a custom mix. */
export function borderSides(
  widths: Readonly<Record<Side, number>>,
): Side | "all" | "none" | "custom" {
  const active = SIDES.filter((side) => widths[side] > 0);
  if (active.length === 0) return "none";
  if (active.length === 4 && SIDES.every((side) => widths[side] === widths.top)) return "all";
  return active.length === 1 ? active[0]! : "custom";
}

/** Border width patch that puts `width` on `side` (or every side) and clears the others. */
export function borderWidthPatch(side: Side | "all", width: number): StylePatch {
  const value = `${formatNumber(Math.max(0, width))}px`;
  if (side === "all")
    return {
      "border-width": value,
      ...Object.fromEntries(SIDES.map((item) => [`border-${item}-width`, null])),
    };
  return {
    "border-width": "0px",
    ...Object.fromEntries(
      SIDES.map((item) => [`border-${item}-width`, item === side ? value : null]),
    ),
  };
}

/** A number with the unit it is edited in; `normal` marks the CSS keyword. */
export type UnitValue = { value: number | null; unit: string; normal?: boolean };

export const sameUnitValue = (a: UnitValue, b: UnitValue) =>
  a.value === b.value && a.unit === b.unit && Boolean(a.normal) === Boolean(b.normal);

/** Line height as stored when it is a percent or unitless factor, otherwise computed px. */
export function readLineHeight(declared: string | undefined, computed: string): UnitValue {
  const value = declared?.trim().toLowerCase();
  if (value === "normal" || (!value && computed === "normal"))
    return { value: null, unit: "px", normal: true };
  if (value?.endsWith("%")) {
    const percent = parsePercent(value);
    if (percent !== null) return { value: percent, unit: "%" };
  }
  if (value && /^\d*\.?\d+$/.test(value)) return { value: Number(value), unit: "" };
  const px = parsePx(computed);
  return px === null
    ? { value: null, unit: "px", normal: computed === "normal" }
    : { value: px, unit: "px" };
}

/** Letter spacing in em when stored that way, otherwise computed px ("normal" is 0). */
export function readLetterSpacing(declared: string | undefined, computed: string): UnitValue {
  const value = declared?.trim().toLowerCase();
  if (value?.endsWith("em") && !value.endsWith("rem")) {
    const em = parseFloat(value);
    if (Number.isFinite(em)) return { value: em, unit: "em" };
  }
  if (computed === "normal") return { value: 0, unit: "px" };
  return { value: parsePx(computed) ?? 0, unit: "px" };
}

/** The value written for a typed or scrubbed unit value; undefined ignores the input. */
export function unitValueText(input: CssInput, keywords: Readonly<Record<string, string | null>>) {
  if (input.kind === "keyword")
    return input.keyword in keywords ? keywords[input.keyword] : undefined;
  return `${formatNumber(input.value, 3)}${input.unit}`;
}

// ── Rotation ─────────────────────────────────────────────────────────────

/** Degrees of a CSS angle ("45deg", "0.5turn", "1rad", "100grad", "0"); null otherwise. */
export function angleDegrees(text: string | undefined): number | null {
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?\s*$/i.exec(text ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "turn":
      return value * 360;
    case "rad":
      return (value * 180) / Math.PI;
    case "grad":
      return value * 0.9;
    case "deg":
      return value;
    default:
      return value === 0 ? 0 : null;
  }
}

/** The rotation in a computed `transform` matrix, in degrees (0 for none). */
export function transformRotation(transform: string | undefined): number {
  const match = /^matrix(?:3d)?\(([^)]*)\)$/.exec(transform?.trim() ?? "");
  if (!match) return 0;
  const [a = 1, b = 0] = match[1]!.split(",").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Number(formatNumber((Math.atan2(b, a) * 180) / Math.PI));
}

/** A computed `rotate` value about the z axis, in degrees; 3D rotations read as 0. */
export function rotateDegrees(rotate: string | undefined): number {
  const tokens = (rotate ?? "").trim().split(/\s+/);
  if (tokens.length === 1) return angleDegrees(tokens[0]) ?? 0;
  if (tokens.length === 2 && tokens[0] === "z") return angleDegrees(tokens[1]) ?? 0;
  if (tokens.length === 4 && tokens[0] === "0" && tokens[1] === "0" && Number(tokens[2]) > 0)
    return angleDegrees(tokens[3]) ?? 0;
  return 0;
}

/** An angle in (-180, 180], as the rotate-90° button leaves it. */
export function normalizeDegrees(value: number): number {
  let degrees = ((value % 360) + 360) % 360;
  if (degrees > 180) degrees -= 360;
  return Number(formatNumber(degrees));
}

/**
 * The patch that shows `degrees` of rotation. Rotation is stored as `rotate`; a transform
 * that is only `rotate(…)` moves there, any other transform keeps its share of the angle.
 */
export function rotationPatch(
  degrees: number,
  declaredTransform: string | undefined,
  transformAngle: number,
): StylePatch {
  const pure =
    declaredTransform !== undefined && /^\s*rotate\([^()]*\)\s*$/i.test(declaredTransform);
  const own = Number(formatNumber(pure ? degrees : degrees - transformAngle));
  return { ...(pure ? { transform: null } : {}), rotate: own === 0 ? null : `${own}deg` };
}

// ── Constraints (absolute layers) ────────────────────────────────────────

export type PinAxis = "x" | "y";
/** Which edge an absolute layer keeps its distance to: start (left/top), end, both, or centre. */
export type Pin = "start" | "end" | "center" | "stretch";

const PIN_PROPERTIES = {
  x: { start: "left", end: "right", size: "width" },
  y: { start: "top", end: "bottom", size: "height" },
} as const;

export const pinProperties = (axis: PinAxis) => PIN_PROPERTIES[axis];

const isSetInset = (value: string | undefined) =>
  value !== undefined && value.trim() !== "" && value.trim() !== "auto";

/** The pin of one axis from the specified inset and size values of the layer. */
export function readPin(input: { start?: string; end?: string; size?: string }): Pin {
  if (isSetInset(input.start) && /^(?:calc\(\s*)?50%/.test(input.start!.trim())) return "center";
  if (isSetInset(input.start) && isSetInset(input.end))
    return isSetInset(input.size) ? "start" : "stretch";
  if (isSetInset(input.end)) return "end";
  return "start";
}

/** `left: calc(50% + 12px)`: the start edge kept at a distance from the container's centre. */
export function centeredInset(delta: number): string {
  const amount = Number(formatNumber(Math.abs(delta)));
  if (amount === 0) return "50%";
  return `calc(50% ${delta < 0 ? "-" : "+"} ${amount}px)`;
}

const px = (value: number) => `${formatNumber(value)}px`;

/**
 * The patch that pins `axis` to `pin` and keeps the layer where it is. `start` and `end` are
 * the used insets (computed left/right or top/bottom), `size` the layer's border box and
 * `container` its containing block, all in px. Leaving a stretch fixes the size it had.
 */
export function pinPatch(input: {
  axis: PinAxis;
  pin: Pin;
  current: Pin;
  start: number;
  end: number;
  size: number;
  container: number;
}): StylePatch {
  const { start, end, size } = PIN_PROPERTIES[input.axis];
  const keepSize =
    input.current === "stretch" && input.pin !== "stretch" ? { [size]: px(input.size) } : {};
  switch (input.pin) {
    case "start":
      return { [start]: px(input.start), [end]: null, ...keepSize };
    case "end":
      return { [start]: null, [end]: px(input.end), ...keepSize };
    case "center":
      return {
        [start]: centeredInset(input.start - input.container / 2),
        [end]: null,
        ...keepSize,
      };
    case "stretch":
      return { [start]: px(input.start), [end]: px(input.end), [size]: null };
  }
}

/**
 * Moves the start edge to `next` (the X or Y field) through whichever inset the pin keeps, so
 * a layer pinned right stays pinned right.
 */
export function pinnedPositionPatch(input: {
  axis: PinAxis;
  pin: Pin;
  start: number;
  end: number;
  container: number;
  next: number;
}): StylePatch {
  const { start, end } = PIN_PROPERTIES[input.axis];
  const delta = input.next - input.start;
  switch (input.pin) {
    case "end":
      return { [end]: px(input.end - delta) };
    case "center":
      return { [start]: centeredInset(input.next - input.container / 2) };
    case "stretch":
      return { [start]: px(input.next), [end]: px(input.end - delta) };
    default:
      return { [start]: px(input.next) };
  }
}

/** `inset` is split into its four longhands before one of them changes. */
export function insetExpansion(
  declared: ReadonlyMap<string, string>,
  specified: (property: string) => string,
): StylePatch {
  if (!declared.has("inset")) return {};
  const patch: StylePatch = { inset: null };
  for (const side of ["top", "right", "bottom", "left"]) {
    const value = specified(side);
    if (value && value !== "auto" && !declared.has(side)) patch[side] = value;
  }
  return patch;
}

// ── Align and distribute (several freely placed items) ───────────────────

export type Box = { x: number; y: number; width: number; height: number };
export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type Shift = { dx: number; dy: number };

/** How far each box moves so the selection lines up on an edge or centre of its bounds. */
export function alignBoxes(boxes: readonly Box[], mode: AlignMode): Shift[] {
  if (boxes.length === 0) return [];
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return boxes.map((box) => {
    switch (mode) {
      case "left":
        return { dx: left - box.x, dy: 0 };
      case "center":
        return { dx: (left + right) / 2 - (box.x + box.width / 2), dy: 0 };
      case "right":
        return { dx: right - (box.x + box.width), dy: 0 };
      case "top":
        return { dx: 0, dy: top - box.y };
      case "middle":
        return { dx: 0, dy: (top + bottom) / 2 - (box.y + box.height / 2) };
      case "bottom":
        return { dx: 0, dy: bottom - (box.y + box.height) };
    }
  });
}

/**
 * Equal gaps between the boxes along `axis`. The first and last box (by their start edge)
 * stay; the others move in between in their current order. Fewer than three boxes stay put.
 */
export function distributeBoxes(boxes: readonly Box[], axis: PinAxis): Shift[] {
  const shifts = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return shifts;
  const start = (box: Box) => (axis === "x" ? box.x : box.y);
  const size = (box: Box) => (axis === "x" ? box.width : box.height);
  const order = boxes
    .map((_, index) => index)
    .toSorted((a, b) => start(boxes[a]!) - start(boxes[b]!) || a - b);
  const first = boxes[order[0]!]!;
  const last = boxes[order.at(-1)!]!;
  const span = start(last) + size(last) - start(first);
  const gap = (span - boxes.reduce((total, box) => total + size(box), 0)) / (boxes.length - 1);
  let cursor = start(first);
  for (const index of order) {
    const delta = cursor - start(boxes[index]!);
    shifts[index] = axis === "x" ? { dx: delta, dy: 0 } : { dx: 0, dy: delta };
    cursor += size(boxes[index]!) + gap;
  }
  return shifts;
}

// ── Fills (background layers) ────────────────────────────────────────────

export type BackgroundLayout = { size: string; position: string; repeat: string };
export const DEFAULT_BACKGROUND_LAYOUT: BackgroundLayout = {
  size: "auto",
  position: "0% 0%",
  repeat: "repeat",
};
export type ImageFit = "cover" | "contain" | "tile";
export const IMAGE_FIT_LAYOUTS: Record<ImageFit, BackgroundLayout> = {
  cover: { size: "cover", position: "50% 50%", repeat: "no-repeat" },
  contain: { size: "contain", position: "50% 50%", repeat: "no-repeat" },
  tile: { size: "auto", position: "0% 0%", repeat: "repeat" },
};

export type GradientType = "linear" | "radial" | "conic";
/** OKLab (average color) and OKLCH (nearest hue) are offered; sRGB is CSS's default. */
export type GradientInterpolation = "oklab" | "oklch" | "srgb";
export type GradientStop = { color: string; position: number };
export type Gradient = {
  type: GradientType;
  /** Linear direction or conic start, in degrees. */
  angle: number;
  /** A linear `to right`-style direction kept as written until the angle is edited. */
  direction: string | null;
  interpolation: GradientInterpolation;
  /** Radial shape, size and position, or the conic position, as written. */
  shape: string;
  stops: GradientStop[];
};

export type Fill =
  | { kind: "solid"; color: string; blend: string; layout: BackgroundLayout }
  | { kind: "gradient"; gradient: Gradient; blend: string; layout: BackgroundLayout }
  | { kind: "image"; url: string; blend: string; layout: BackgroundLayout }
  /** A background layer the inspector cannot edit (repeating gradients, px stops…). */
  | { kind: "other"; value: string; blend: string; layout: BackgroundLayout };

const GRADIENT_FUNCTION = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i;
const GRADIENT_CONFIG_START =
  /^(?:-?(?:\d+\.?\d*|\.\d+)(?:deg|turn|rad|grad|px|%|em|rem)?(?:\s|$)|to\s|in\s|from\s|at\s|circle\b|ellipse\b|closest-|farthest-)/i;
const SIDE_ANGLES: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };

function sideAngle(direction: string): number | null {
  const sides = direction
    .trim()
    .toLowerCase()
    .replace(/^to\s+/, "")
    .split(/\s+/);
  if (sides.length === 1) return SIDE_ANGLES[sides[0]!] ?? null;
  const vertical = sides.find((side) => side === "top" || side === "bottom");
  const horizontal = sides.find((side) => side === "left" || side === "right");
  if (sides.length !== 2 || !vertical || !horizontal) return null;
  // The corner's angle on a square box; the written direction is kept for other boxes.
  return { "top-right": 45, "bottom-right": 135, "bottom-left": 225, "top-left": 315 }[
    `${vertical}-${horizontal}`
  ]!;
}

/** Stop positions as CSS fills them: first 0%, last 100%, the rest spread between. */
function resolveStopPositions(positions: ReadonlyArray<number | null>): number[] {
  const result = [...positions];
  if (result.length === 0) return [];
  if (result[0] === null) result[0] = 0;
  if (result.at(-1) === null) result[result.length - 1] = 100;
  let previous = 0;
  for (let index = 0; index < result.length; index++) {
    if (result[index] !== null) {
      // A position lower than an earlier one is raised to it.
      result[index] = Math.max(result[index]!, result[previous] ?? 0);
      previous = index;
      continue;
    }
    let next = index + 1;
    while (result[next] === null) next++;
    const from = result[previous]!;
    const to = result[next]!;
    for (let fill = index; fill < next; fill++)
      result[fill] = from + ((to - from) * (fill - previous)) / (next - previous);
    index = next - 1;
  }
  return result.map((value) => Number(formatNumber(value!, 2)));
}

/**
 * A linear, radial or conic gradient the inspector can edit; null for anything it could not
 * write back faithfully (repeating gradients, colour hints, stop positions outside percent).
 */
export function parseGradient(value: string): Gradient | null {
  const match = GRADIENT_FUNCTION.exec(value.trim());
  if (!match || match[1]) return null;
  const type = match[2]!.toLowerCase() as GradientType;
  const args = splitTopLevel(match[3]!, ",").map((part) => part.trim());
  let config = GRADIENT_CONFIG_START.test(args[0] ?? "") ? args.shift()! : "";
  let interpolation: GradientInterpolation = "srgb";
  const method = /\bin\s+([a-z0-9-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?/i.exec(
    config,
  );
  if (method) {
    const space = method[1]!.toLowerCase();
    if (space !== "oklab" && space !== "oklch" && space !== "srgb") return null;
    if (method[2] && method[2].toLowerCase() !== "shorter") return null;
    interpolation = space;
    config = (config.slice(0, method.index) + config.slice(method.index + method[0].length)).trim();
  }
  let angle = type === "linear" ? 180 : 0;
  let direction: string | null = null;
  let shape = "";
  if (type === "linear" && config) {
    if (/^to\s/i.test(config)) {
      const fromSide = sideAngle(config);
      if (fromSide === null) return null;
      angle = fromSide;
      direction = config.replace(/\s+/g, " ").toLowerCase();
    } else {
      const degrees = angleDegrees(config);
      if (degrees === null) return null;
      angle = degrees;
    }
  } else if (type === "conic") {
    const from = /^from\s+(\S+)\s*/i.exec(config);
    if (from) {
      const degrees = angleDegrees(from[1]);
      if (degrees === null) return null;
      angle = degrees;
      config = config.slice(from[0].length).trim();
    }
    shape = config;
  } else shape = config;
  const colors: string[] = [];
  const positions: Array<number | null> = [];
  for (const arg of args) {
    const tokens = splitTopLevel(arg, " ").filter(Boolean);
    const stopPositions: number[] = [];
    while (tokens.length > 1 && /^-?(?:\d+\.?\d*|\.\d+)%$/.test(tokens.at(-1)!))
      stopPositions.unshift(parseFloat(tokens.pop()!));
    if (tokens.length === 0 || stopPositions.length > 2) return null;
    // A length is a colour hint or a position outside percent: not editable here.
    const length = /^-?(?:\d+\.?\d*|\.\d+)[a-z%]*$/i;
    if (tokens.some((token) => length.test(token))) return null;
    const color = tokens.join(" ");
    if (stopPositions.length === 0) {
      colors.push(color);
      positions.push(null);
    }
    for (const position of stopPositions) {
      colors.push(color);
      positions.push(position);
    }
  }
  if (colors.length < 2) return null;
  const resolved = resolveStopPositions(positions);
  return {
    type,
    angle: Number(formatNumber(angle)),
    direction,
    interpolation,
    shape,
    stops: colors.map((color, index) => ({ color, position: resolved[index]! })),
  };
}

export function formatGradient(gradient: Gradient): string {
  const config: string[] = [];
  if (gradient.interpolation !== "srgb") config.push(`in ${gradient.interpolation}`);
  if (gradient.type === "linear")
    config.push(gradient.direction ?? `${formatNumber(gradient.angle)}deg`);
  if (gradient.type === "conic" && gradient.angle !== 0)
    config.push(`from ${formatNumber(gradient.angle)}deg`);
  if (gradient.type !== "linear" && gradient.shape) config.push(gradient.shape);
  const stops = gradient.stops.map((stop) => `${stop.color} ${formatNumber(stop.position)}%`);
  return `${gradient.type}-gradient(${[config.join(" "), ...stops].filter(Boolean).join(", ")})`;
}

/** Stops spread evenly from 0% to 100%, in their current order (Distribute colors). */
export function distributeStops(stops: readonly GradientStop[]): GradientStop[] {
  const ordered = stops.toSorted((a, b) => a.position - b.position);
  const last = ordered.length - 1;
  return ordered.map((stop, index) => ({
    color: stop.color,
    position: last < 1 ? 0 : Number(formatNumber((index / last) * 100)),
  }));
}

/** A stop added in the widest gap between neighbours, with the colour before it. */
export function addGradientStop(stops: readonly GradientStop[]): GradientStop[] {
  const ordered = stops.toSorted((a, b) => a.position - b.position);
  if (ordered.length === 0) return [{ color: "#000000", position: 0 }];
  let at = 0;
  let widest = -1;
  for (let index = 0; index < ordered.length - 1; index++) {
    const gap = ordered[index + 1]!.position - ordered[index]!.position;
    if (gap > widest) {
      widest = gap;
      at = index;
    }
  }
  if (ordered.length === 1 || widest <= 0)
    return [...ordered, { color: ordered.at(-1)!.color, position: 100 }];
  const position = Number(formatNumber((ordered[at]!.position + ordered[at + 1]!.position) / 2));
  return [
    ...ordered.slice(0, at + 1),
    { color: ordered[at]!.color, position },
    ...ordered.slice(at + 1),
  ];
}

/** A solid above other fills is written as a plain two-stop gradient of one colour. */
function solidLayerColor(gradient: Gradient): string | null {
  const [from, to] = gradient.stops;
  return gradient.type === "linear" &&
    gradient.stops.length === 2 &&
    gradient.direction === null &&
    gradient.angle === 180 &&
    gradient.interpolation === "srgb" &&
    from!.position === 0 &&
    to!.position === 100 &&
    from!.color.replace(/\s+/g, "").toLowerCase() === to!.color.replace(/\s+/g, "").toLowerCase()
    ? from!.color
    : null;
}

/** One background-image layer as a fill. */
function parseImageLayer(value: string, blend: string, layout: BackgroundLayout): Fill {
  const url = /^url\(\s*(["']?)(.*?)\1\s*\)$/i.exec(value);
  if (url) return { kind: "image", url: url[2]!, blend, layout };
  const gradient = parseGradient(value);
  if (gradient) {
    const solid = solidLayerColor(gradient);
    return solid
      ? { kind: "solid", color: solid, blend, layout }
      : { kind: "gradient", gradient, blend, layout };
  }
  return { kind: "other", value, blend, layout };
}

const listItem = (list: readonly string[], index: number, fallback: string) =>
  list.length === 0 ? fallback : (list[index % list.length] ?? fallback);
const splitList = (value: string | undefined) =>
  !value || value.trim() === "" ? [] : splitTopLevel(value, ",").map((part) => part.trim());

/**
 * The fill stack, top first: every `background-image` layer, then the background colour (when
 * it paints) at the bottom. Lists shorter than the image list repeat, as CSS repeats them.
 */
export function parseFills(input: {
  image: string;
  color: string | null;
  blend?: string;
  size?: string;
  position?: string;
  repeat?: string;
}): Fill[] {
  const images = input.image.trim() === "none" ? [] : splitList(input.image);
  const blends = splitList(input.blend);
  const sizes = splitList(input.size);
  const positions = splitList(input.position);
  const repeats = splitList(input.repeat);
  const fills = images.map((image, index) =>
    parseImageLayer(image, listItem(blends, index, "normal"), {
      size: listItem(sizes, index, DEFAULT_BACKGROUND_LAYOUT.size),
      position: listItem(positions, index, DEFAULT_BACKGROUND_LAYOUT.position),
      repeat: listItem(repeats, index, DEFAULT_BACKGROUND_LAYOUT.repeat),
    }),
  );
  if (input.color)
    fills.push({
      kind: "solid",
      color: input.color,
      blend: "normal",
      layout: DEFAULT_BACKGROUND_LAYOUT,
    });
  return fills;
}

function fillImageValue(fill: Fill): string {
  switch (fill.kind) {
    case "solid":
      return `linear-gradient(${fill.color}, ${fill.color})`;
    case "gradient":
      return formatGradient(fill.gradient);
    case "image":
      return `url("${fill.url.replace(/["\\]/g, "")}")`;
    case "other":
      return fill.value;
  }
}

/**
 * The background longhands for a fill stack. A solid at the bottom is the background colour;
 * every other fill is an image layer. `transparent` keeps a frame from showing the default
 * white of its root when its last fill is removed.
 */
export function formatFills(fills: readonly Fill[], { frame = false } = {}): StylePatch {
  const last = fills.at(-1);
  const bottom = last?.kind === "solid" ? last : null;
  const layers = bottom ? fills.slice(0, -1) : fills;
  const list = (read: (fill: Fill) => string, fallback: string) =>
    layers.some((fill) => read(fill) !== fallback) ? layers.map(read).join(", ") : null;
  return {
    background: null,
    "background-image": layers.length > 0 ? layers.map(fillImageValue).join(", ") : null,
    "background-color": bottom ? bottom.color : frame ? "transparent" : null,
    "background-blend-mode": list((fill) => fill.blend, "normal"),
    "background-size": list((fill) => fill.layout.size, DEFAULT_BACKGROUND_LAYOUT.size),
    "background-position": list((fill) => fill.layout.position, DEFAULT_BACKGROUND_LAYOUT.position),
    "background-repeat": list((fill) => fill.layout.repeat, DEFAULT_BACKGROUND_LAYOUT.repeat),
  };
}

/** Which of the inspector's image fits a layout is, or null for a custom one. */
export function imageFitOf(layout: BackgroundLayout): ImageFit | null {
  const size = layout.size.trim().toLowerCase();
  const repeat = layout.repeat.trim().toLowerCase();
  if (size === "cover" || size === "cover cover") return "cover";
  if (size === "contain" || size === "contain contain") return "contain";
  if (
    (size === "auto" || size === "auto auto") &&
    (repeat === "repeat" || repeat === "repeat repeat")
  )
    return "tile";
  return null;
}

/** Moves one item of a list to another index (drag reorder). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...items];
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

// ── Shadows, inner shadows and drop shadows ──────────────────────────────

export type ShadowKind = "box" | "drop" | "text";

/** Box shadows split into two sections: outer (Shadow) and inset (Inner shadow). */
export function splitBoxShadows(value: string | undefined): { drop: Shadow[]; inner: Shadow[] } {
  const shadows = parseBoxShadow(value);
  return {
    drop: shadows.filter((shadow) => !shadow.inset),
    inner: shadows.filter((shadow) => shadow.inset),
  };
}

/** Inset shadows first, as they are stored; null when there are none. */
export function joinBoxShadows(inner: readonly Shadow[], drop: readonly Shadow[]): string | null {
  return formatBoxShadow([
    ...inner.map((shadow) => ({ ...shadow, inset: true })),
    ...drop.map((shadow) => ({ ...shadow, inset: false })),
  ]);
}

/** `text-shadow` takes no spread and no inset. */
export function formatTextShadow(shadows: readonly Shadow[]): string | null {
  if (shadows.length === 0) return null;
  return shadows
    .map(
      (shadow) =>
        `${formatNumber(shadow.x)}px ${formatNumber(shadow.y)}px ${formatNumber(shadow.blur)}px ${shadow.color}`,
    )
    .join(", ");
}

export const sameShadows = (a: readonly Shadow[], b: readonly Shadow[]) =>
  formatBoxShadow(a) === formatBoxShadow(b);

// ── Filters (layer and backdrop) ─────────────────────────────────────────

export const FILTER_TYPES = [
  "blur",
  "brightness",
  "contrast",
  "grayscale",
  "hue-rotate",
  "invert",
  "saturate",
  "sepia",
] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export type FilterEntry =
  | { kind: "filter"; type: FilterType; amount: number; unit: string }
  | { kind: "drop-shadow"; shadow: Shadow }
  /** A filter function the inspector shows but does not edit (opacity(), url()…). */
  | { kind: "other"; value: string };

/** The unit each filter amount is edited in. */
export const FILTER_UNITS: Readonly<Record<FilterType, string>> = {
  blur: "px",
  brightness: "%",
  contrast: "%",
  grayscale: "%",
  "hue-rotate": "deg",
  invert: "%",
  saturate: "%",
  sepia: "%",
};

/**
 * A new filter's amount: blur 4px, the others a visible change for each type.
 */
export const FILTER_DEFAULTS: Readonly<Record<FilterType, number>> = {
  blur: 4,
  brightness: 120,
  contrast: 120,
  grayscale: 100,
  "hue-rotate": 90,
  invert: 100,
  saturate: 150,
  sepia: 100,
};

export const defaultFilter = (type: FilterType): FilterEntry => ({
  kind: "filter",
  type,
  amount: FILTER_DEFAULTS[type],
  unit: FILTER_UNITS[type],
});

function parseFilterAmount(
  type: FilterType,
  args: string,
): { amount: number; unit: string } | null {
  const text = args.trim().toLowerCase();
  if (type === "blur") {
    if (text === "") return { amount: 0, unit: "px" };
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|em)?$/.exec(text);
    return match ? { amount: Number(match[1]), unit: match[2] ?? "px" } : null;
  }
  if (type === "hue-rotate") {
    const degrees = text === "" ? 0 : angleDegrees(text);
    return degrees === null ? null : { amount: degrees, unit: "deg" };
  }
  if (text === "") return { amount: 100, unit: "%" };
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(%)?$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return { amount: Number(formatNumber(match[2] ? value : value * 100)), unit: "%" };
}

/** The functions of a `filter` or `backdrop-filter` value, in order. */
export function parseFilterList(value: string | undefined): FilterEntry[] {
  if (!value || value.trim() === "" || value.trim() === "none") return [];
  const entries: FilterEntry[] = [];
  for (const token of splitTopLevel(value.trim(), " ").filter(Boolean)) {
    const match = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(token);
    const name = match?.[1]!.toLowerCase();
    if (match && name === "drop-shadow") {
      const [shadow] = parseBoxShadow(match[2]);
      entries.push(shadow ? { kind: "drop-shadow", shadow } : { kind: "other", value: token });
      continue;
    }
    if (match && (FILTER_TYPES as readonly string[]).includes(name!)) {
      const amount = parseFilterAmount(name as FilterType, match[2]!);
      if (amount) {
        entries.push({ kind: "filter", type: name as FilterType, ...amount });
        continue;
      }
    }
    entries.push({ kind: "other", value: token });
  }
  return entries;
}

export function formatFilterEntry(entry: FilterEntry): string {
  switch (entry.kind) {
    case "filter":
      return `${entry.type}(${formatNumber(entry.amount, 3)}${entry.unit})`;
    case "drop-shadow":
      return `drop-shadow(${formatNumber(entry.shadow.x)}px ${formatNumber(entry.shadow.y)}px ${formatNumber(entry.shadow.blur)}px ${entry.shadow.color})`;
    case "other":
      return entry.value;
  }
}

export function formatFilterList(entries: readonly FilterEntry[]): string | null {
  return entries.length === 0 ? null : entries.map(formatFilterEntry).join(" ");
}

/**
 * Replaces the entries of one group (drop shadows, or everything else) inside a filter list,
 * keeping the other group where it was. Extra entries go to the end, removed ones are dropped.
 */
export function replaceFilterGroup(
  current: readonly FilterEntry[],
  member: (entry: FilterEntry) => boolean,
  next: readonly FilterEntry[],
): FilterEntry[] {
  const result: FilterEntry[] = [];
  let used = 0;
  for (const entry of current) {
    if (!member(entry)) result.push(entry);
    else if (used < next.length) result.push(next[used++]!);
  }
  return [...result, ...next.slice(used)];
}

export const isDropShadowFilter = (entry: FilterEntry) => entry.kind === "drop-shadow";

// ── Text formatting ──────────────────────────────────────────────────────

export type TextWrap = "none" | "normal" | "pretty" | "balance";

export function readTextWrap(input: { mode: string; style: string; whiteSpace: string }): TextWrap {
  if (input.mode === "nowrap" || input.whiteSpace === "nowrap" || input.whiteSpace === "pre")
    return "none";
  if (input.style === "pretty") return "pretty";
  if (input.style === "balance") return "balance";
  return "normal";
}

/** The Wrap options as `text-wrap`; leaving None also drops a `white-space: nowrap`. */
export function textWrapPatch(wrap: TextWrap, declaredWhiteSpace: string | undefined): StylePatch {
  return {
    "text-wrap-mode": null,
    "text-wrap-style": null,
    "text-wrap": wrap === "none" ? "nowrap" : wrap === "normal" ? null : wrap,
    ...(wrap !== "none" && declaredWhiteSpace?.trim() === "nowrap" ? { "white-space": null } : {}),
  };
}

/** Truncation as a line clamp: null when off, otherwise the number of lines kept. */
export function readTruncation(input: { lineClamp: string; textOverflow: string }): number | null {
  const lines = Number(input.lineClamp);
  if (Number.isInteger(lines) && lines > 0) return lines;
  return input.textOverflow === "ellipsis" ? 1 : null;
}

/** Ellipsis after `lines` lines. */
export function truncationPatch(lines: number | null): StylePatch {
  if (lines === null)
    return {
      display: null,
      "-webkit-box-orient": null,
      "-webkit-line-clamp": null,
      "line-clamp": null,
      "text-overflow": null,
      overflow: null,
    };
  return {
    display: "-webkit-box",
    "-webkit-box-orient": "vertical",
    "-webkit-line-clamp": String(Math.max(1, Math.round(lines))),
    overflow: "hidden",
    "text-overflow": "ellipsis",
  };
}

export type VerticalAlign = "top" | "center" | "bottom";

const verticalOf = (value: string): VerticalAlign =>
  value === "center" || value === "safe center" || value === "unsafe center"
    ? "center"
    : /(?:^|[-\s])end$/.test(value)
      ? "bottom"
      : "top";

/**
 * Where text sits vertically in its box. A flex row aligns its cross axis, a flex column its
 * main axis, and any other box uses `align-content` (block alignment).
 */
export function readTextVerticalAlign(input: {
  display: string;
  direction: string;
  alignItems: string;
  justifyContent: string;
  alignContent: string;
}): VerticalAlign {
  if (isFlex(input.display))
    return verticalOf(
      input.direction.startsWith("column") ? input.justifyContent : input.alignItems,
    );
  return verticalOf(input.alignContent);
}

export function textVerticalAlignPatch(
  input: { display: string; direction: string },
  align: VerticalAlign,
): StylePatch {
  if (isFlex(input.display)) {
    const value = align === "top" ? "flex-start" : align === "bottom" ? "flex-end" : "center";
    return input.direction.startsWith("column")
      ? { "justify-content": value }
      : { "align-items": value };
  }
  return { "align-content": align === "top" ? null : align === "bottom" ? "end" : "center" };
}

// ── Underline ────────────────────────────────────────────────────────────

export type DecorationLine = "underline" | "overline" | "line-through";
export const DECORATION_LINES: readonly DecorationLine[] = [
  "underline",
  "overline",
  "line-through",
];

/** The first decoration line drawn, or null when there is none. */
export function readDecorationLine(value: string | undefined): DecorationLine | null {
  const lines = (value ?? "").split(/\s+/);
  return DECORATION_LINES.find((line) => lines.includes(line)) ?? null;
}

/** Every declaration the Underline section owns, cleared. */
export const UNDERLINE_RESET: StylePatch = {
  "text-decoration": null,
  "text-decoration-line": null,
  "text-decoration-style": null,
  "text-decoration-color": null,
  "text-decoration-thickness": null,
  "text-decoration-skip-ink": null,
  "text-underline-offset": null,
  "text-underline-position": null,
};

/**
 * A length that may be `auto` (underline thickness and offset): the specified value keeps
 * percent; otherwise the computed px.
 */
export function readAutoLength(specified: string | undefined, computed: string): UnitValue {
  const value = (specified ?? "").trim().toLowerCase();
  if (value.endsWith("%")) {
    const percent = parsePercent(value);
    if (percent !== null) return { value: percent, unit: "%" };
  }
  if (
    value === "auto" ||
    value === "from-font" ||
    (!value && (computed === "auto" || computed === "from-font"))
  )
    return { value: null, unit: "px", normal: true };
  const length = parsePx(computed);
  return length === null
    ? { value: null, unit: "px", normal: true }
    : { value: length, unit: "px" };
}
