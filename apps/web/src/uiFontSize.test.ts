import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// use the text-ui*/text-chat* tokens, never fixed Tailwind sizes (AGENTS.md) — titles, headings, and exported/static surfaces are the only exceptions, so fixed sizes may shrink but must not grow
const MAX_FIXED_TEXT_SIZES = 23;

const FIXED_TEXT_SIZE = /(?<![\w[-])text-(?:xs|sm|base|\[(?:9|1[0-4])(?:\.5)?px\])(?![\w-])/g;
const LONG_FORM_TOKEN = /text-\[length:var\(--app-font-size-/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__screenshots__" ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|browser)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe("UI font sizes", () => {
  const srcDir = import.meta.dirname;
  const files = sourceFiles(srcDir).map((path) => ({
    path: relative(srcDir, path),
    code: readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
      .join("\n"),
  }));

  it("does not add fixed Tailwind text sizes", () => {
    const hits = files.flatMap(({ path, code }) =>
      [...code.matchAll(FIXED_TEXT_SIZE)].map((match) => `${path}: ${match[0]}`),
    );
    expect(
      hits.length,
      `Use text-ui / text-ui-sm / text-ui-xs / text-ui-lg instead of:\n${hits.join("\n")}`,
    ).toBeLessThanOrEqual(MAX_FIXED_TEXT_SIZES);
  });

  it("uses the short text-ui* tokens instead of the long var() form", () => {
    const hits = files.filter(({ code }) => LONG_FORM_TOKEN.test(code)).map(({ path }) => path);
    expect(hits).toEqual([]);
  });
});
