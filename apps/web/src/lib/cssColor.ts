// FILE: cssColor.ts
// Purpose: Robust CSS color parsing/normalization for the browser editor UI.
// Layer: Web utility

export interface ParsedCssColor {
  /** Normalized 6-digit lowercase hex, e.g. "#1a2b3c". */
  hex: string;
  /** Alpha channel in [0, 1]. */
  alpha: number;
}

function channelToHex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel)))
    .toString(16)
    .padStart(2, "0");
}

function expandShortHex(value: string): string {
  return value
    .split("")
    .map((char) => char + char)
    .join("");
}

function parseHexColor(value: string): ParsedCssColor | null {
  const match = value.match(/^#([\da-f]{3,8})$/i);
  if (!match?.[1]) {
    return null;
  }
  const digits = match[1].toLowerCase();
  if (digits.length !== 3 && digits.length !== 4 && digits.length !== 6 && digits.length !== 8) {
    return null;
  }
  const full = digits.length <= 4 ? expandShortHex(digits) : digits;
  const hex = `#${full.slice(0, 6)}`;
  const alpha = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
  return { hex, alpha: Math.round(alpha * 1000) / 1000 };
}

let sharedCanvasContext: CanvasRenderingContext2D | null | undefined;

function canvasContext(): CanvasRenderingContext2D | null {
  if (sharedCanvasContext === undefined) {
    try {
      sharedCanvasContext = document.createElement("canvas").getContext("2d");
    } catch {
      sharedCanvasContext = null;
    }
  }
  return sharedCanvasContext;
}

// Canvas `fillStyle` normalizes every valid CSS color (named, hsl(), rgb() with
// percentages, color(), lab(), ...) to "#rrggbb" or "rgba(r, g, b, a)". Invalid
// values leave fillStyle untouched, so assigning against two different sentinels
// distinguishes "invalid" from "parsed to the sentinel color".
function normalizeViaCanvas(value: string): string | null {
  const context = canvasContext();
  if (!context) {
    return null;
  }
  context.fillStyle = "#010203";
  context.fillStyle = value;
  const first = String(context.fillStyle);
  context.fillStyle = "#030201";
  context.fillStyle = value;
  const second = String(context.fillStyle);
  return first === second ? first : null;
}

/**
 * Parses any valid CSS color into normalized hex + alpha. Returns null for
 * values that are not a plain color (gradients, var() references, keywords like
 * "currentcolor" resolve per-context and are rejected by canvas, etc).
 */
export function parseCssColor(value: string | undefined): ParsedCssColor | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const direct = parseHexColor(trimmed);
  if (direct) {
    return direct;
  }
  const normalized = normalizeViaCanvas(trimmed);
  if (!normalized) {
    return null;
  }
  const asHex = parseHexColor(normalized);
  if (asHex) {
    return asHex;
  }
  const rgbaMatch = normalized.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*(?:\.\d+)?)\s*)?\)$/i,
  );
  if (!rgbaMatch) {
    return null;
  }
  const [, r, g, b, a] = rgbaMatch;
  return {
    hex: `#${channelToHex(Number(r))}${channelToHex(Number(g))}${channelToHex(Number(b))}`,
    alpha: a === undefined || a === "" ? 1 : Math.max(0, Math.min(1, Number(a))),
  };
}

/** 6-digit hex for `<input type="color">`; falls back to black for non-colors. */
export function cssColorToHexInput(value: string | undefined): string {
  return parseCssColor(value)?.hex ?? "#000000";
}

/**
 * Composes a picked 6-digit hex with an alpha channel, emitting 8-digit hex
 * when translucent so existing transparency survives swatch edits.
 */
export function hexColorWithAlpha(hex: string, alpha: number): string {
  if (alpha >= 1) {
    return hex;
  }
  return `${hex}${channelToHex(alpha * 255)}`;
}

interface EyeDropperConstructor {
  new (): { open: () => Promise<{ sRGBHex: string }> };
}

/** Feature-detected EyeDropper API (Chromium-only). */
export function eyeDropperConstructor(): EyeDropperConstructor | null {
  const candidate = (window as { EyeDropper?: unknown }).EyeDropper;
  return typeof candidate === "function" ? (candidate as EyeDropperConstructor) : null;
}
