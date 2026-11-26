// FILE: inspectorColor.ts
// Purpose: Colour spaces behind the canvas colour picker: sRGB transfer, OKLab/OKLCH, HSL,
//          HSV and OKHSV (the perceptual hue picker), wide-gamut parsing for the Clipped badge,
//          and the picker's text formats. Pure functions, no DOM.
// Layer: Canvas editor logic
// Notes: OKLab and OKHSV follow Björn Ottosson's published definitions (public math, MIT
//        reference).

import { clamp, formatNumber, toCssColor, type Rgba } from "./inspectorValues";

export type LinearRgb = { r: number; g: number; b: number };
export type Oklab = { l: number; a: number; b: number };
export type Oklch = { l: number; c: number; h: number };
/** Hue in degrees [0, 360), saturation and value or lightness in [0, 1]. */
export type Hsv = { h: number; s: number; v: number };
export type Hsl = { h: number; s: number; l: number };

const toLinear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const fromLinear = (value: number) =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

export function rgbaToLinear(color: Rgba): LinearRgb {
  return { r: toLinear(color.r / 255), g: toLinear(color.g / 255), b: toLinear(color.b / 255) };
}

/** Linear sRGB to 8-bit sRGB, clamped into the gamut. */
export function linearToRgba(color: LinearRgb, alpha = 1): Rgba {
  const byte = (value: number) => Math.round(clamp(fromLinear(clamp(value, 0, 1)), 0, 1) * 255);
  return { r: byte(color.r), g: byte(color.g), b: byte(color.b), a: clamp(alpha, 0, 1) };
}

export function linearToOklab({ r, g, b }: LinearRgb): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToLinear({ l: lightness, a, b }: Oklab): LinearRgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

export function rgbaToOklch(color: Rgba): Oklch {
  const { l, a, b } = linearToOklab(rgbaToLinear(color));
  const c = Math.hypot(a, b);
  const h = c < 1e-4 ? 0 : ((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
  return { l, c, h };
}

export function oklchToLinear({ l, c, h }: Oklch): LinearRgb {
  const radians = (h * Math.PI) / 180;
  return oklabToLinear({ l, a: c * Math.cos(radians), b: c * Math.sin(radians) });
}

// ── HSV and HSL (classic) ────────────────────────────────────────────────

export function rgbaToHsv(color: Rgba): Hsv {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0)
    h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (((h * 60) % 360) + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgba({ h, s, v }: Hsv, alpha = 1): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return {
    r: Math.round(f(5) * 255),
    g: Math.round(f(3) * 255),
    b: Math.round(f(1) * 255),
    a: clamp(alpha, 0, 1),
  };
}

export function rgbaToHsl(color: Rgba): Hsl {
  const { h, s: sv, v } = rgbaToHsv(color);
  const l = v * (1 - sv / 2);
  const s = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s, l };
}

// ── OKHSV ────────────────────────────────────────────────────────────────

const K1 = 0.206;
const K2 = 0.03;
const K3 = (1 + K1) / (1 + K2);
const toe = (x: number) => 0.5 * (K3 * x - K1 + Math.sqrt((K3 * x - K1) ** 2 + 4 * K2 * K3 * x));
const toeInverse = (x: number) => (x * x + K1 * x) / (K3 * (x + K2));

/** The largest saturation (C/L) for a unit hue direction (a, b) that stays inside sRGB. */
function maxSaturation(a: number, b: number): number {
  let coefficients: [number, number, number, number, number];
  let weights: [number, number, number];
  if (-1.88170328 * a - 0.80936493 * b > 1) {
    coefficients = [1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245];
    weights = [4.0767416621, -3.3077115913, 0.2309699292];
  } else if (1.81444104 * a - 1.19445276 * b > 1) {
    coefficients = [0.73956515, -0.45954404, 0.08285427, 0.1254107, 0.14503204];
    weights = [-1.2684380046, 2.6097574011, -0.3413193965];
  } else {
    coefficients = [1.35733652, -0.00915799, -1.1513021, -0.50559606, 0.00692167];
    weights = [-0.0041960863, -0.7034186147, 1.707614701];
  }
  const [k0, k1, k2, k3, k4] = coefficients;
  const [wl, wm, ws] = weights;
  let saturation = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;
  // One Halley step refines the polynomial estimate.
  const kl = 0.3963377774 * a + 0.2158037573 * b;
  const km = -0.1055613458 * a - 0.0638541728 * b;
  const ks = -0.0894841775 * a - 1.291485548 * b;
  const l_ = 1 + saturation * kl;
  const m_ = 1 + saturation * km;
  const s_ = 1 + saturation * ks;
  const f = wl * l_ ** 3 + wm * m_ ** 3 + ws * s_ ** 3;
  const f1 = wl * 3 * kl * l_ * l_ + wm * 3 * km * m_ * m_ + ws * 3 * ks * s_ * s_;
  const f2 = wl * 6 * kl * kl * l_ + wm * 6 * km * km * m_ + ws * 6 * ks * ks * s_;
  saturation -= (f * f1) / (f1 * f1 - 0.5 * f * f2);
  return saturation;
}

/** The lightness and chroma of the most saturated in-gamut colour of a hue. */
function findCusp(a: number, b: number): { l: number; c: number } {
  const saturation = maxSaturation(a, b);
  const max = oklabToLinear({ l: 1, a: saturation * a, b: saturation * b });
  const l = Math.cbrt(1 / Math.max(max.r, max.g, max.b));
  return { l, c: l * saturation };
}

/**
 * OKHSV at one hue as a function of saturation and value. The gamut cusp depends on the hue
 * only, so drawing the picker's area computes it once instead of once per pixel.
 */
export function okhsvSampler(hue: number): (s: number, v: number) => LinearRgb {
  const a = Math.cos((hue * Math.PI) / 180);
  const b = Math.sin((hue * Math.PI) / 180);
  const cusp = findCusp(a, b);
  const sMax = cusp.c / cusp.l;
  const tMax = cusp.c / (1 - cusp.l);
  const s0 = 0.5;
  const k = 1 - s0 / sMax;
  return (s, v) => {
    if (v <= 0) return { r: 0, g: 0, b: 0 };
    const lV = 1 - (s * s0) / (s0 + tMax - tMax * k * s);
    const cV = (s * tMax * s0) / (s0 + tMax - tMax * k * s);
    let l = v * lV;
    let c = v * cV;
    const lVt = toeInverse(lV);
    const cVt = (cV * lVt) / lV;
    const lNew = toeInverse(l);
    c = (c * lNew) / l;
    l = lNew;
    const scale = oklabToLinear({ l: lVt, a: a * cVt, b: b * cVt });
    const scaleL = Math.cbrt(1 / Math.max(scale.r, scale.g, scale.b, 0));
    l *= scaleL;
    c *= scaleL;
    return oklabToLinear({ l, a: c * a, b: c * b });
  };
}

/** OKHSV (hue in degrees) to linear sRGB. */
export function okhsvToLinear({ h, s, v }: Hsv): LinearRgb {
  return okhsvSampler(h)(s, v);
}

/** sRGB to OKHSV. Greys keep `hue` (the picker's current hue), as they have none. */
export function rgbaToOkhsv(color: Rgba, hue = 0): Hsv {
  const lab = linearToOklab(rgbaToLinear(color));
  const c = Math.hypot(lab.a, lab.b);
  if (lab.l <= 1e-6) return { h: hue, s: 0, v: 0 };
  if (c < 1e-4) return { h: hue, s: 0, v: clamp(toe(lab.l), 0, 1) };
  const a = lab.a / c;
  const b = lab.b / c;
  const h = ((((Math.atan2(lab.b, lab.a) * 180) / Math.PI) % 360) + 360) % 360;
  const cusp = findCusp(a, b);
  const sMax = cusp.c / cusp.l;
  const tMax = cusp.c / (1 - cusp.l);
  const s0 = 0.5;
  const k = 1 - s0 / sMax;
  const t = tMax / (c + lab.l * tMax);
  const lV = t * lab.l;
  const cV = t * c;
  const lVt = toeInverse(lV);
  const cVt = (cV * lVt) / lV;
  const scale = oklabToLinear({ l: lVt, a: a * cVt, b: b * cVt });
  const scaleL = Math.cbrt(1 / Math.max(scale.r, scale.g, scale.b, 0));
  // Value and saturation depend on the toe-corrected lightness and the triangle's chroma only.
  const v = toe(lab.l / scaleL) / lV;
  const s = ((s0 + tMax) * cV) / (tMax * s0 + tMax * k * cV);
  return { h, s: clamp(s, 0, 1), v: clamp(v, 0, 1) };
}

/** The picker's area modes: OKHSV (uniform hue, the default) or classic HSV. */
export type PickerSpace = "okhsv" | "hsv";

export function pickerToRgba(space: PickerSpace, hsv: Hsv, alpha: number): Rgba {
  return space === "okhsv" ? linearToRgba(okhsvToLinear(hsv), alpha) : hsvToRgba(hsv, alpha);
}

export function rgbaToPicker(space: PickerSpace, color: Rgba, hue: number): Hsv {
  if (space === "okhsv") return rgbaToOkhsv(color, hue);
  const hsv = rgbaToHsv(color);
  return hsv.s === 0 || hsv.v === 0 ? { ...hsv, h: hue } : hsv;
}

// ── Wide gamut (the Clipped badge) ───────────────────────────────────────

const P3_TO_XYZ = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
] as const;
const XYZ_TO_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
] as const;

function multiply(matrix: readonly (readonly number[])[], [x, y, z]: readonly number[]) {
  return matrix.map((row) => row[0]! * x! + row[1]! * y! + row[2]! * z!);
}

/** A CSS number or percentage, with `percent` as 100%; null for anything else. */
function amount(token: string | undefined, percent: number): number | null {
  if (token === undefined) return null;
  if (token === "none") return 0;
  if (token.endsWith("%")) {
    const value = Number(token.slice(0, -1));
    return Number.isFinite(value) ? (value / 100) * percent : null;
  }
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

/**
 * A colour in a space wider than 8-bit sRGB (oklch, oklab, display-p3, srgb with values out of
 * range) as linear sRGB, which may fall outside [0, 1]; null for other syntax.
 */
export function parseWideColor(text: string): { linear: LinearRgb; alpha: number } | null {
  const value = text.trim().toLowerCase();
  const fn = /^(oklch|oklab|color)\(\s*([^)]*)\)$/.exec(value);
  if (!fn) return null;
  const [body, alphaText] = fn[2]!.split("/").map((part) => part.trim());
  const tokens = body!.split(/\s+/);
  const alpha = alphaText === undefined ? 1 : (amount(alphaText, 1) ?? 1);
  if (fn[1] === "oklch") {
    const [l, c, h] = [amount(tokens[0], 1), amount(tokens[1], 0.4), parseFloat(tokens[2] ?? "")];
    if (l === null || c === null || !Number.isFinite(h)) return null;
    return { linear: oklchToLinear({ l, c, h }), alpha };
  }
  if (fn[1] === "oklab") {
    const [l, a, b] = [amount(tokens[0], 1), amount(tokens[1], 0.4), amount(tokens[2], 0.4)];
    if (l === null || a === null || b === null) return null;
    return { linear: oklabToLinear({ l, a, b }), alpha };
  }
  const [space, ...channels] = tokens;
  const numbers = channels.map((token) => amount(token, 1));
  if (numbers.length !== 3 || numbers.some((item) => item === null)) return null;
  const [r, g, b] = numbers as [number, number, number];
  const sign = (n: number) => Math.sign(n) * toLinear(Math.abs(n));
  if (space === "srgb") return { linear: { r: sign(r), g: sign(g), b: sign(b) }, alpha };
  if (space === "srgb-linear") return { linear: { r, g, b }, alpha };
  if (space === "display-p3") {
    const [x, y, z] = multiply(XYZ_TO_SRGB, multiply(P3_TO_XYZ, [sign(r), sign(g), sign(b)]));
    return { linear: { r: x!, g: y!, b: z! }, alpha };
  }
  return null;
}

/**
 * Whether a colour lies outside sRGB beyond rounding: OKLCH written with three decimals can
 * miss the gamut edge by a few thousandths, which no 8-bit channel would show.
 */
export function isOutOfSrgb({ r, g, b }: LinearRgb): boolean {
  const epsilon = 0.002;
  return [r, g, b].some((value) => value < -epsilon || value > 1 + epsilon);
}

// ── Text formats ─────────────────────────────────────────────────────────

export type ColorFormat = "hex" | "rgb" | "hsl" | "oklch";
export const COLOR_FORMATS: readonly ColorFormat[] = ["oklch", "hsl", "rgb", "hex"];

const alphaSuffix = (alpha: number) =>
  alpha >= 0.995 ? "" : ` / ${formatNumber(Math.round(alpha * 100))}%`;

/** A colour as CSS text in one of the picker's formats. */
export function formatColor(color: Rgba, format: ColorFormat): string {
  switch (format) {
    case "hex":
      return toCssColor(color);
    case "rgb":
      return `rgb(${color.r} ${color.g} ${color.b}${alphaSuffix(color.a)})`;
    case "hsl": {
      const { h, s, l } = rgbaToHsl(color);
      return `hsl(${formatNumber(h, 1)} ${formatNumber(s * 100, 1)}% ${formatNumber(l * 100, 1)}%${alphaSuffix(color.a)})`;
    }
    case "oklch": {
      const { l, c, h } = rgbaToOklch(color);
      return `oklch(${formatNumber(l, 3)} ${formatNumber(c, 3)} ${formatNumber(h, 1)}${alphaSuffix(color.a)})`;
    }
  }
}

/** The channel rows of the picker: OKLCH, HSL and RGB numbers. */
export function colorChannels(color: Rgba): Record<"oklch" | "hsl" | "rgb", string[]> {
  const oklch = rgbaToOklch(color);
  const hsl = rgbaToHsl(color);
  return {
    oklch: [formatNumber(oklch.l, 3), formatNumber(oklch.c, 3), formatNumber(oklch.h, 1)],
    hsl: [
      formatNumber(hsl.h, 1),
      `${formatNumber(hsl.s * 100, 1)}%`,
      `${formatNumber(hsl.l * 100, 1)}%`,
    ],
    rgb: [String(color.r), String(color.g), String(color.b)],
  };
}

/**
 * Nudges the number under the caret in a colour text (arrow keys in the picker's field). The
 * step is 1, or 0.01 for numbers below 1 with decimals (OKLCH lightness and chroma).
 */
export function nudgeNumberAt(
  text: string,
  caret: number,
  direction: 1 | -1,
  large: boolean,
): { text: string; caret: number } | null {
  const pattern = /-?\d*\.?\d+/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret < start || caret > end) continue;
    const value = Number(match[0]);
    const decimals = match[0].includes(".") ? match[0].split(".")[1]!.length : 0;
    const small = decimals > 0 && Math.abs(value) < 1;
    const step = (small ? 0.01 : 1) * (large ? 10 : 1);
    const next = formatNumber(value + direction * step, Math.max(decimals, small ? 2 : 0));
    const replaced = text.slice(0, start) + next + text.slice(end);
    return { text: replaced, caret: start + next.length };
  }
  return null;
}
