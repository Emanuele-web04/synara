// FILE: terminalRuntimeAppearance.ts
// Purpose: Resolve terminal theme, font, and system-message styling from app chrome tokens.
// Layer: Terminal runtime infrastructure

import { Terminal, type ITheme } from "@xterm/xterm";

const FALLBACK_MONO_FONT_FAMILY =
  '"JetBrainsMono NFM", "JetBrainsMono NF", "JetBrains Mono", monospace';

export function getTerminalFontFamily(): string {
  if (typeof window === "undefined") {
    return FALLBACK_MONO_FONT_FAMILY;
  }

  const configuredFontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue("--terminal-font-family")
    .trim();
  return configuredFontFamily || FALLBACK_MONO_FONT_FAMILY;
}

function resolveTerminalSurfaceColors(): { background: string; foreground: string } {
  const isDark = document.documentElement.classList.contains("dark");
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.pointerEvents = "none";
  probe.style.opacity = "0";
  probe.style.backgroundColor = "var(--background)";
  probe.style.color = "var(--foreground)";
  document.body.append(probe);

  const computedProbeStyles = getComputedStyle(probe);
  const background = computedProbeStyles.backgroundColor;
  const foreground = computedProbeStyles.color;
  probe.remove();

  return {
    background: background || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)"),
    foreground: foreground || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)"),
  };
}

export function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const { background, foreground } = resolveTerminalSurfaceColors();

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

export function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}
