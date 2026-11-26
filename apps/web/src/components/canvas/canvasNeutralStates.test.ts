import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// `bg-accent` and `ring-ring` are the theme accent (orange-red in the default theme, blue
// in others), not neutral states. Canvas chrome hovers, selections and focus use Synara's
// grays (`fileRowToneClassName`, `--color-background-button-secondary-hover`); the blue
// `--canvas-accent` is only for selection drawn on the canvas itself.
const THEME_ACCENT_STATE = /(?<![\w-])(?:[\w-]+:)*(?:bg-accent|focus-within:ring-ring)(?![\w-])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|browser)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("canvas chrome states", () => {
  it("never uses the theme accent as a hover, selection or focus fill", () => {
    const dir = import.meta.dirname;
    const hits = sourceFiles(dir).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(THEME_ACCENT_STATE)].map(
        (match) => `${relative(dir, path)}: ${match[0]}`,
      ),
    );
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("recognizes the accent state shapes", () => {
    const flagged = ["hover:bg-accent", "data-[state=on]:bg-accent", "focus-within:ring-ring/50"];
    const allowed = ["hover:bg-accent-foreground", "text-accent-foreground", "ring-foreground/30"];
    expect(flagged.filter((sample) => !sample.match(THEME_ACCENT_STATE))).toEqual([]);
    expect(allowed.filter((sample) => sample.match(THEME_ACCENT_STATE))).toEqual([]);
  });
});
