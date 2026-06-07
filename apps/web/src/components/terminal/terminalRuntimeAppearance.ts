// FILE: terminalRuntimeAppearance.ts
// Purpose: Resolve terminal theme, font, and system-message styling from app chrome tokens.
// Layer: Terminal runtime infrastructure

import { Terminal, type ITheme } from "@xterm/xterm";

const FALLBACK_MONO_FONT_FAMILY =
  '"JetBrains Mono", "JetBrainsMono NFM", "JetBrainsMono NF", monospace';
const FALLBACK_TERMINAL_FONT_SIZE_PX = 12;
const TERMINAL_FONT_WEIGHT = 300;
const TERMINAL_BOLD_FONT_WEIGHT = 500;

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

function toLegacyXtermColor(cssColor: string, fallback: string): string {
  const trimmedCssColor = cssColor.trim();
  if (!trimmedCssColor) {
    return fallback;
  }
  if (/^#[\da-f]{3,8}$/i.test(trimmedCssColor)) {
    return trimmedCssColor;
  }
  if (/^rgba?\(\s*\d{1,3}\s*,/i.test(trimmedCssColor)) {
    return trimmedCssColor;
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

function resolveTerminalCssColor(
  cssColor: string,
  fallback: string,
  property: "backgroundColor" | "color" = "color",
): string {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) {
    return fallback;
  }

  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.pointerEvents = "none";
  probe.style.opacity = "0";
  probe.style[property] = cssColor;
  document.body.append(probe);

  const resolvedColor = getComputedStyle(probe)[property];
  probe.remove();

  return toLegacyXtermColor(resolvedColor, fallback);
}

export function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackTheme = isDark ? DARK_TERMINAL_THEME_FALLBACK : LIGHT_TERMINAL_THEME_FALLBACK;
  const foregroundFallback = fallbackTheme.foreground;

  return {
    background: resolveTerminalCssColor(
      "var(--color-token-terminal-background, var(--color-background-surface))",
      fallbackTheme.background,
      "backgroundColor",
    ),
    black: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-black, var(--color-text-foreground-tertiary))",
      fallbackTheme.black,
    ),
    blue: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-blue, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.blue,
    ),
    brightBlack: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-black, var(--color-text-foreground-secondary))",
      fallbackTheme.brightBlack,
    ),
    brightBlue: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-blue, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.brightBlue,
    ),
    brightCyan: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-cyan, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.brightCyan,
    ),
    brightGreen: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-green, var(--color-decoration-added))",
      fallbackTheme.brightGreen,
    ),
    brightMagenta: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-magenta, var(--color-accent-purple, var(--color-text-accent)))",
      fallbackTheme.brightMagenta,
    ),
    brightRed: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-red, var(--color-decoration-deleted))",
      fallbackTheme.brightRed,
    ),
    brightWhite: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-white, var(--color-text-foreground))",
      fallbackTheme.brightWhite,
    ),
    brightYellow: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-bright-yellow, var(--warning))",
      fallbackTheme.brightYellow,
    ),
    cursor: resolveTerminalCssColor(
      "var(--color-token-terminal-foreground, var(--color-text-foreground, var(--foreground)))",
      foregroundFallback,
    ),
    cyan: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-cyan, var(--color-accent-blue, var(--color-text-accent)))",
      fallbackTheme.cyan,
    ),
    foreground: resolveTerminalCssColor(
      "var(--color-token-terminal-foreground, var(--color-text-foreground, var(--foreground)))",
      fallbackTheme.foreground,
    ),
    green: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-green, var(--color-decoration-added))",
      fallbackTheme.green,
    ),
    magenta: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-magenta, var(--color-accent-purple, var(--color-text-accent)))",
      fallbackTheme.magenta,
    ),
    red: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-red, var(--color-decoration-deleted))",
      fallbackTheme.red,
    ),
    scrollbarSliderActiveBackground: resolveTerminalCssColor(
      "var(--color-token-scrollbar-slider-active-background)",
      fallbackTheme.scrollbarSliderActiveBackground,
      "backgroundColor",
    ),
    scrollbarSliderBackground: resolveTerminalCssColor(
      "var(--color-token-scrollbar-slider-background)",
      fallbackTheme.scrollbarSliderBackground,
      "backgroundColor",
    ),
    scrollbarSliderHoverBackground: resolveTerminalCssColor(
      "var(--color-token-scrollbar-slider-hover-background)",
      fallbackTheme.scrollbarSliderHoverBackground,
      "backgroundColor",
    ),
    selectionBackground: resolveTerminalCssColor(
      "color-mix(in srgb, var(--color-text-accent) 26%, transparent)",
      fallbackTheme.selectionBackground,
      "backgroundColor",
    ),
    white: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-white, var(--color-text-foreground))",
      fallbackTheme.white,
    ),
    yellow: resolveTerminalCssColor(
      "var(--color-token-terminal-ansi-yellow, var(--warning))",
      fallbackTheme.yellow,
    ),
  };
}

export function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}
