import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The chrome's own steps — the frame band, the block's hairline, the seam and the
// scrollbar — used to mix toward absolute black and white, so a warm or tinted palette
// rendered them as neutral grey while its surface, text and icons carried the hue. They
// must read the theme's ink instead, which is the token that already holds the palette's
// own extreme. A literal here is the bug, not a shortcut.
const CHROME_TOKENS = [
  "--app-rail-shell-tone",
  "--app-rail-panel-background",
  "--app-rail-inset-border",
  "--app-rail-inset-border-hover",
  "--seam-line",
];

function declarations(css: string, token: string): string[] {
  return [...css.matchAll(new RegExp(`^\\s*${token}:\\s*([^;]+);`, "gm"))].map((match) =>
    match[1]!.trim(),
  );
}

describe("chrome colour coverage", () => {
  const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

  it("derives every chrome step from a theme token", () => {
    for (const token of CHROME_TOKENS) {
      const values = declarations(css, token);
      expect(values.length, `${token} is declared`).toBeGreaterThan(0);
      for (const value of values) {
        // A collapsed rail declares the panel transparent rather than painting a fill.
        if (value === "transparent") continue;
        expect(value, `${token}: ${value}`).not.toMatch(/\b(black|white)\b|rgba?\(/);
        expect(value, `${token}: ${value}`).toMatch(/var\(--color-/);
      }
    }
  });

  it("paints scrollbar thumbs from the theme's ink", () => {
    const thumbs = [...css.matchAll(/::-webkit-scrollbar-thumb[^{]*\{([^}]*)\}/g)].map(
      (match) => match[1]!,
    );
    expect(thumbs.length).toBeGreaterThan(0);
    for (const block of thumbs) {
      // `--foreground` is the same theme ink under its older name.
      expect(block).toMatch(/var\(--(?:color-text-foreground|foreground)\)/);
      expect(block).not.toMatch(/rgba?\(/);
    }
  });
});
