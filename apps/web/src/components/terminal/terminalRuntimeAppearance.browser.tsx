// FILE: terminalRuntimeAppearance.browser.ts
// Purpose: Verifies terminal theme colors resolve from live browser CSS variables.
// Layer: Browser rendering tests for terminal runtime appearance

import { afterEach, describe, expect, it } from "vitest";

import {
  getTerminalBoldFontWeight,
  getTerminalFontWeight,
  terminalThemeFromApp,
} from "./terminalRuntimeAppearance";

const root = document.documentElement;
const originalRootClassName = root.className;
const originalRootStyle = root.getAttribute("style");

afterEach(() => {
  root.className = originalRootClassName;
  if (originalRootStyle === null) {
    root.removeAttribute("style");
  } else {
    root.setAttribute("style", originalRootStyle);
  }
});

describe("terminalThemeFromApp", () => {
  it("uses Codex-style terminal tokens from the active theme pack", () => {
    root.classList.add("dark");
    root.style.setProperty("--color-token-terminal-background", "#0f0f11");
    root.style.setProperty("--color-token-terminal-foreground", "#e3e4e6");
    root.style.setProperty("--color-token-terminal-ansi-blue", "#606acc");
    root.style.setProperty("--color-token-terminal-ansi-green", "#56a554");
    root.style.setProperty("--color-token-terminal-ansi-magenta", "#c2a1ff");
    root.style.setProperty("--color-token-terminal-ansi-red", "#ff7e78");
    root.style.setProperty("--color-token-terminal-ansi-yellow", "#f5b44a");
    root.style.setProperty("--color-text-accent", "#8f96db");
    root.style.setProperty("--color-token-scrollbar-slider-background", "rgba(255,255,255,0.1)");
    root.style.setProperty(
      "--color-token-scrollbar-slider-hover-background",
      "rgba(255,255,255,0.2)",
    );
    root.style.setProperty(
      "--color-token-scrollbar-slider-active-background",
      "rgba(255,255,255,0.3)",
    );

    const theme = terminalThemeFromApp();

    expect(theme.background).toBe("rgb(15, 15, 17)");
    expect(theme.foreground).toBe("rgb(227, 228, 230)");
    expect(theme.cursor).toBe("rgb(227, 228, 230)");
    expect(theme.blue).toBe("rgb(96, 106, 204)");
    expect(theme.green).toBe("rgb(86, 165, 84)");
    expect(theme.magenta).toBe("rgb(194, 161, 255)");
    expect(theme.red).toBe("rgb(255, 126, 120)");
    expect(theme.yellow).toBe("rgb(245, 180, 74)");
    expect(theme.selectionBackground).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
  });

  it("keeps terminal text intentionally lighter than bold shell output", () => {
    expect(getTerminalFontWeight()).toBe(300);
    expect(getTerminalBoldFontWeight()).toBe(500);
  });
});
