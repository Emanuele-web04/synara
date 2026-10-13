import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Tailwind compiles these variants to `:is(<anchor>:has(…) *)`, `:is(<anchor>:has(…) > *)`
// or `:is(:where(.group):has(…) *)`. Any one such rule in the stylesheet makes Chrome
// restyle the whole document on DOM insertions, so every transcript row that mounts
// while scrolling or opening a chat recalculated ~2,000 elements. Use a descendant
// subject instead (`[&:has(x)_input]:…`), a CSS variable read by `*:` children, or a
// named variant from index.css (`project-header-focus:`, `menu-item-has-action:`).
const COSTLY_HAS_VARIANT =
  /(?<![\w[-])(?:(?:group|peer)-has-[^\s"'`]*|(?:not-)?has-[^\s"'`:]*(?:\[[^\s"'`]*?\])?[^\s"'`:]*:\*{1,2}:[^\s"'`]*)/g;

// Samples use "~" for "-": Tailwind scans this file too, and a literal sample would be
// compiled into a real stylesheet rule and bring the cost back.
function unscanned(classes: string[]): string[] {
  return classes.map((name) => name.replaceAll("~", "-"));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__screenshots__" ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|browser)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe(":has() selector variants", () => {
  it("does not use variants that force whole-document style recalculation", () => {
    const srcDir = import.meta.dirname;
    const hits = sourceFiles(srcDir).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(COSTLY_HAS_VARIANT)].map(
        (match) => `${relative(srcDir, path)}: ${match[0]}`,
      ),
    );
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("recognizes each costly variant shape", () => {
    const samples = unscanned([
      "md:group~has~[:focus~visible]/project~header:opacity~100",
      "group~has~data~[sidebar=menu~action]/menu~item:pe~8",
      "has~data~[size=sm]:*:min~h~6",
      "has~data~[align=inline~start]:**:[input]:ps~2",
      "not~has~[button]:**:[svg]:opacity~80",
      "has~[+[data~slot=x]]:*:data~[slot=y]:pe~7",
    ]);
    const cheap = unscanned([
      "project~header~focus:opacity~100",
      "[&:has([data~align=inline~start])_input]:ps~2",
      "has~data~[size=sm]:[~~chip~min~h:~~spacing(6)]",
      "has~[+[data~slot=combobox~clear]]:hidden",
      "*:min~h~(~~chip~min~h)",
    ]);
    expect(samples.filter((sample) => !sample.match(COSTLY_HAS_VARIANT))).toEqual([]);
    expect(cheap.filter((sample) => sample.match(COSTLY_HAS_VARIANT))).toEqual([]);
  });
});
