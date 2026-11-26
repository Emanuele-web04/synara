import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Each `<IconButton …>` opening tag in a source text (braces balanced, `=>` skipped). */
function iconButtonTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<IconButton\b/g)) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0 && source[end - 1] !== "=") break;
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

describe("inspector icon buttons", () => {
  // An icon says nothing until it is named: every icon-only button in the inspector shows
  // its label as a tooltip, as Rotate 90°, Resize to fill and Formatting always did.
  it("all show their label as a tooltip", () => {
    const dir = import.meta.dirname;
    const missing = readdirSync(dir)
      .filter((name) => name.endsWith(".tsx") && !/\.(test|browser)\.tsx$/.test(name))
      .flatMap((name) =>
        iconButtonTags(readFileSync(join(dir, name), "utf8"))
          .filter((tag) => !/\btooltip=/.test(tag))
          .map((tag) => `${name}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`),
      );
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("reads multi-line tags with arrow functions", () => {
    expect(
      iconButtonTags(
        `<IconButton\n  label={t("a")}\n  onClick={() => run(1 > 0)}\n>x</IconButton>`,
      ),
    ).toEqual([`<IconButton\n  label={t("a")}\n  onClick={() => run(1 > 0)}\n>`]);
  });
});
