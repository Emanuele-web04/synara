// FILE: terminalRuntimeAppearance.ts
// Purpose: Resolve terminal theme, font, and system-message styling from app chrome tokens.
// Layer: Terminal runtime infrastructure

import { Terminal, type ITheme } from "@xterm/xterm";

const FALLBACK_MONO_FONT_FAMILY =
  '"JetBrains Mono", "JetBrainsMono NFM", "JetBrainsMono NF", monospace';
const FALLBACK_TERMINAL_FONT_SIZE_PX = 12;
const TERMINAL_FONT_WEIGHT = 300;
const TERMINAL_BOLD_FONT_WEIGHT = 500;
// WCAG AA. TUIs such as Claude Code default to truecolor palettes tuned for dark backgrounds,
// which bypass the ANSI theme and fade into a light terminal unless xterm raises their contrast.
const LIGHT_TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;

const DARK_TERMINAL_THEME_FALLBACK = {
  background: "rgb(14, 18, 24)",
  black: "rgb(24, 30, 38)",
  blue: "rgb(137, 190, 255)",
  brightBlack: "rgb(110, 120, 136)",
  brightBlue: "rgb(174, 210, 255)",
  brightCyan: "rgb(167, 244, 247)",
  brightGreen: "rgb(176, 245, 186)",
  brightMagenta: "rgb(229, 203, 255)",
  brightRed: "rgb(255, 168, 180)",
  brightWhite: "rgb(244, 247, 252)",
  brightYellow: "rgb(255, 224, 149)",
  cursor: "rgb(180, 203, 255)",
  cyan: "rgb(124, 232, 237)",
  foreground: "rgb(237, 241, 247)",
  green: "rgb(134, 231, 149)",
  magenta: "rgb(208, 176, 255)",
  red: "rgb(255, 122, 142)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.2)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.07)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.14)",
  selectionBackground: "rgba(180, 203, 255, 0.25)",
  white: "rgb(210, 218, 230)",
  yellow: "rgb(244, 205, 114)",
} as const satisfies ITheme;

const LIGHT_TERMINAL_THEME_FALLBACK = {
  background: "rgb(255, 255, 255)",
  black: "rgb(44, 53, 66)",
  blue: "rgb(72, 102, 163)",
  brightBlack: "rgb(112, 123, 140)",
  brightBlue: "rgb(91, 124, 194)",
  brightCyan: "rgb(70, 149, 164)",
  brightGreen: "rgb(85, 148, 111)",
  brightMagenta: "rgb(153, 107, 172)",
  brightRed: "rgb(212, 95, 112)",
  brightWhite: "rgb(236, 240, 246)",
  brightYellow: "rgb(173, 133, 45)",
  cursor: "rgb(38, 56, 78)",
  cyan: "rgb(53, 127, 141)",
  foreground: "rgb(28, 33, 41)",
  green: "rgb(60, 126, 86)",
  magenta: "rgb(132, 86, 149)",
  red: "rgb(191, 70, 87)",
  scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.24)",
  scrollbarSliderBackground: "rgba(0, 0, 0, 0.1)",
  scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.18)",
  selectionBackground: "rgba(37, 63, 99, 0.2)",
  white: "rgb(210, 215, 223)",
  yellow: "rgb(146, 112, 35)",
} as const satisfies ITheme;

let colorNormalizationContext: CanvasRenderingContext2D | null | undefined;
let colorProbeElement: HTMLDivElement | null = null;
const normalizedColorCache = new Map<string, string>();
const COLOR_CACHE_LIMIT = 256;
let cachedThemeResult: { key: string; theme: ITheme } | null = null;

function rememberNormalizedColor(cacheKey: string, resolved: string): string {
  if (normalizedColorCache.size >= COLOR_CACHE_LIMIT) {
    normalizedColorCache.clear();
  }
  normalizedColorCache.set(cacheKey, resolved);
  return resolved;
}

function getReusableColorProbe(): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) {
    return null;
  }
  if (colorProbeElement && colorProbeElement.isConnected) {
    return colorProbeElement;
  }
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;width:0;height:0;pointer-events:none;opacity:0;visibility:hidden;contain:strict;left:-10000px;top:-10000px;";
  document.body.append(probe);
  colorProbeElement = probe;
  return probe;
}

export function getTerminalFontFamily(): string {
  if (typeof window === "undefined") {
    return FALLBACK_MONO_FONT_FAMILY;
  }

  const configuredFontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue("--terminal-font-family")
    .trim();
  return configuredFontFamily || FALLBACK_MONO_FONT_FAMILY;
}

export function getTerminalFontSizePx(): number {
  if (typeof window === "undefined") {
    return FALLBACK_TERMINAL_FONT_SIZE_PX;
  }

  const rawValue = getComputedStyle(document.documentElement)
    .getPropertyValue("--app-font-size-terminal")
    .trim();
  const parsedValue = Number.parseFloat(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : FALLBACK_TERMINAL_FONT_SIZE_PX;
}

export function getTerminalFontWeight(): number {
  return TERMINAL_FONT_WEIGHT;
}

export function getTerminalBoldFontWeight(): number {
  return TERMINAL_BOLD_FONT_WEIGHT;
}

// 1 leaves colors untouched; the dark theme keeps its palette as designed.
export function getTerminalMinimumContrastRatio(): number {
  if (typeof document === "undefined" || document.documentElement.classList.contains("dark")) {
    return 1;
  }
  return LIGHT_TERMINAL_MINIMUM_CONTRAST_RATIO;
}

function getColorNormalizationContext(): CanvasRenderingContext2D | null {
  if (colorNormalizationContext !== undefined) {
    return colorNormalizationContext;
  }
  if (typeof document === "undefined") {
    colorNormalizationContext = null;
    return colorNormalizationContext;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  colorNormalizationContext = canvas.getContext("2d", { willReadFrequently: true });
  if (colorNormalizationContext) {
    colorNormalizationContext.globalCompositeOperation = "copy";
  }
  return colorNormalizationContext;
}

function parseHexToRgbColor(value: string): string | null {
  const match = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (!match) return null;
  const hex = match[1]!;
  if (hex.length === 3 || hex.length === 4) {
    const r = Number.parseInt(hex[0]! + hex[0]!, 16);
    const g = Number.parseInt(hex[1]! + hex[1]!, 16);
    const b = Number.parseInt(hex[2]! + hex[2]!, 16);
    if (hex.length === 3) return `rgb(${r}, ${g}, ${b})`;
    const a = Number.parseInt(hex[3]! + hex[3]!, 16);
    return a >= 255
      ? `rgb(${r}, ${g}, ${b})`
      : `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (hex.length === 6) return `rgb(${r}, ${g}, ${b})`;
  const a = Number.parseInt(hex.slice(6, 8), 16);
  return a >= 255
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
}

function normalizeSimpleLegacyColor(value: string): string | null {
  const fromHex = parseHexToRgbColor(value);
  if (fromHex) return fromHex;
  if (/^rgba?\(\s*\d{1,3}\s*,/i.test(value)) {
    return value;
  }
  return null;
}

function toLegacyXtermColor(cssColor: string, fallback: string): string {
  const trimmedCssColor = cssColor.trim();
  if (!trimmedCssColor) {
    return fallback;
  }
  const simpleColor = normalizeSimpleLegacyColor(trimmedCssColor);
  if (simpleColor) {
    return simpleColor;
  }

  const canvasContext = getColorNormalizationContext();
  if (!canvasContext) {
    return fallback;
  }

  canvasContext.clearRect(0, 0, 1, 1);
  canvasContext.fillStyle = "#000001";
  canvasContext.fillStyle = trimmedCssColor;
  if (canvasContext.fillStyle === "#000001" && trimmedCssColor !== "#000001") {
    return fallback;
  }

  canvasContext.fillRect(0, 0, 1, 1);
  const pixel = canvasContext.getImageData(0, 0, 1, 1).data;
  const red = pixel[0] ?? 0;
  const green = pixel[1] ?? 0;
  const blue = pixel[2] ?? 0;
  const alpha = pixel[3] ?? 255;
  if (alpha >= 255) {
    return `rgb(${red}, ${green}, ${blue})`;
  }
  return `rgba(${red}, ${green}, ${blue}, ${Number((alpha / 255).toFixed(3))})`;
}

function resolveCssVarChain(
  rootStyle: CSSStyleDeclaration | null,
  varNames: readonly string[],
): string | null {
  if (!rootStyle) return null;
  for (const name of varNames) {
    const value = rootStyle.getPropertyValue(name).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function resolveTerminalCssColor(
  cssColor: string,
  fallback: string,
  property: "backgroundColor" | "color" = "color",
  rootStyle?: CSSStyleDeclaration | null,
  varNames?: readonly string[],
): string {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) {
    return fallback;
  }

  // Fast path: read the custom property straight from the single root computed
  // style snapshot and normalize hex/rgb(a) without DOM probes or canvas readbacks.
  const directValue = varNames ? resolveCssVarChain(rootStyle ?? null, varNames) : null;
  const directLegacyColor = directValue ? normalizeSimpleLegacyColor(directValue) : null;
  if (directLegacyColor) {
    return directLegacyColor;
  }

  const probeInput = directValue ?? cssColor;
  const cacheKey = `${property}:${probeInput}:${fallback}`;
  const cached = normalizedColorCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const probe = getReusableColorProbe();
  if (!probe) {
    return fallback;
  }

  probe.style[property] = "";
  probe.style[property] = probeInput;
  const resolvedColor = getComputedStyle(probe)[property];
  return rememberNormalizedColor(cacheKey, toLegacyXtermColor(resolvedColor, fallback));
}

// A see-through terminal background (whole-window glass) needs xterm's `allowTransparency`.
export function isTerminalBackgroundTranslucent(theme: ITheme): boolean {
  return theme.background?.startsWith("rgba(") ?? false;
}

// The terminal's background color: `--app-terminal-surface: transparent` (whole-window glass,
// index.css) clears it. The cleared color keeps the theme's RGB at zero alpha rather than
// becoming transparent black: xterm paints reverse-video text in the opaque form of the theme
// background, which would otherwise be black on any theme.
function resolveTerminalBackground(
  fallback: string,
  rootStyle: CSSStyleDeclaration | null,
): string {
  const background = resolveTerminalCssColor(
    "var(--color-token-terminal-background, var(--color-background-surface))",
    fallback,
    "backgroundColor",
    rootStyle,
    ["--color-token-terminal-background", "--color-background-surface"],
  );
  const surface = resolveTerminalCssColor(
    "var(--app-terminal-surface, black)",
    "black",
    "backgroundColor",
    rootStyle,
    ["--app-terminal-surface"],
  );
  if (!/^rgba\(.*,\s*0\)$/.test(surface) && surface !== "transparent") {
    return background;
  }
  const channels = background.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  return channels ? `rgba(${channels[1]}, ${channels[2]}, ${channels[3]}, 0)` : "rgba(0, 0, 0, 0)";
}

const THEME_SIGNATURE_VARS = [
  "--color-token-terminal-background",
  "--color-background-surface",
  "--app-terminal-surface",
  "--color-token-terminal-foreground",
  "--color-text-foreground",
  "--foreground",
  "--color-text-accent",
  "--color-token-terminal-ansi-red",
  "--color-token-terminal-ansi-green",
  "--color-token-terminal-ansi-blue",
  "--color-token-terminal-ansi-magenta",
  "--color-token-terminal-ansi-yellow",
  "--color-token-scrollbar-slider-background",
  "--color-token-scrollbar-slider-hover-background",
  "--color-token-scrollbar-slider-active-background",
] as const;

function computeThemeCacheKey(isDark: boolean, rootStyle: CSSStyleDeclaration | null): string {
  const parts: string[] = [isDark ? "dark" : "light", document.documentElement.className];
  if (rootStyle) {
    for (const varName of THEME_SIGNATURE_VARS) {
      parts.push(rootStyle.getPropertyValue(varName).trim());
    }
  }
  return parts.join("|");
}

export function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const rootStyle =
    typeof window !== "undefined" ? window.getComputedStyle(document.documentElement) : null;
  const cacheKey = computeThemeCacheKey(isDark, rootStyle);
  if (cachedThemeResult && cachedThemeResult.key === cacheKey) {
    return cachedThemeResult.theme;
  }

  const fallbackTheme = isDark ? DARK_TERMINAL_THEME_FALLBACK : LIGHT_TERMINAL_THEME_FALLBACK;
  const foregroundFallback = fallbackTheme.foreground;

  const theme: ITheme = {
    background: resolveTerminalBackground(fallbackTheme.background, rootStyle),
    black: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-black, var(--color-text-foreground-tertiary))",
      fallbackTheme.black,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-black", "--color-text-foreground-tertiary"],
    ),
    blue: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-blue, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.blue,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-blue", "--color-accent-blue", "--color-text-accent"],
    ),
    brightBlack: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-black, var(--color-text-foreground-secondary))",
      fallbackTheme.brightBlack,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-bright-black", "--color-text-foreground-secondary"],
    ),
    brightBlue: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-blue, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.brightBlue,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-bright-blue", "--color-accent-blue", "--color-text-accent"],
    ),
    brightCyan: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-cyan, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.brightCyan,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-bright-cyan", "--color-accent-blue", "--color-text-accent"],
    ),
    brightGreen: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-green, var(--color-decoration-added))",
      fallbackTheme.brightGreen,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-bright-green", "--color-decoration-added"],
    ),
    brightMagenta: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-magenta, var(--color-accent-purple, var(--color-text-accent)))",
      fallbackTheme.brightMagenta,
      "color",
      rootStyle,
      [
        "--color-token-terminal-ansi-bright-magenta",
        "--color-accent-purple",
        "--color-text-accent",
      ],
    ),
    brightRed: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-red, var(--color-decoration-deleted))",
      fallbackTheme.brightRed,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-bright-red", "--color-decoration-deleted"],
    ),
    brightWhite: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-white, var(--color-text-foreground))",
      fallbackTheme.brightWhite,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-bright-white", "--color-text-foreground"],
    ),
    brightYellow: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-yellow, var(--warning))",
      fallbackTheme.brightYellow,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-bright-yellow", "--warning"],
    ),
    cursor: resolveTerminalCssColor(
      "var(--color-token-terminal-foreground, var(--color-text-foreground, var(--foreground)))",
      foregroundFallback,
      "color",
      rootStyle,
      ["--color-token-terminal-foreground", "--color-text-foreground", "--foreground"],
    ),
    cyan: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-cyan, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.cyan,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-cyan", "--color-accent-blue", "--color-text-accent"],
    ),
    foreground: resolveTerminalCssColor(
      "var(--color-token-terminal-foreground, var(--color-text-foreground, var(--foreground)))",
      fallbackTheme.foreground,
      "color",
      rootStyle,
      ["--color-token-terminal-foreground", "--color-text-foreground", "--foreground"],
    ),
    green: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-green, var(--color-decoration-added))",
      fallbackTheme.green,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-green", "--color-decoration-added"],
    ),
    magenta: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-magenta, var(--color-accent-purple, var(--color-text-accent)))",
      fallbackTheme.magenta,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-magenta", "--color-accent-purple", "--color-text-accent"],
    ),
    red: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-red, var(--color-decoration-deleted))",
      fallbackTheme.red,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-red", "--color-decoration-deleted"],
    ),
    scrollbarSliderActiveBackground: resolveTerminalCssColor(
      "var(--color-token-scrollbar-slider-active-background)",
      fallbackTheme.scrollbarSliderActiveBackground,
      "backgroundColor",
      rootStyle,
      ["--color-token-scrollbar-slider-active-background"],
    ),
    scrollbarSliderBackground: resolveTerminalCssColor(
      "var(--color-token-scrollbar-slider-background)",
      fallbackTheme.scrollbarSliderBackground,
      "backgroundColor",
      rootStyle,
      ["--color-token-scrollbar-slider-background"],
    ),
    scrollbarSliderHoverBackground: resolveTerminalCssColor(
      "var(--color-token-scrollbar-slider-hover-background)",
      fallbackTheme.scrollbarSliderHoverBackground,
      "backgroundColor",
      rootStyle,
      ["--color-token-scrollbar-slider-hover-background"],
    ),
    selectionBackground: resolveTerminalCssColor(
      "color-mix(in srgb, var(--color-text-accent) 26%, transparent)",
      fallbackTheme.selectionBackground,
      "backgroundColor",
      rootStyle,
    ),
    white: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-white, var(--color-text-foreground))",
      fallbackTheme.white,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-white", "--color-text-foreground"],
    ),
    yellow: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-yellow, var(--warning))",
      fallbackTheme.yellow,
      "color",
      rootStyle,
      ["--color-token-terminal-ansi-yellow", "--warning"],
    ),
  };

  cachedThemeResult = { key: cacheKey, theme };
  return theme;
}

export function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}
