import { describe, expect, it } from "vitest";

import { CENTRAL_ICON_DIRECTORIES, collectReferencedCentralIcons } from "./centralIconAssets";

describe("Central icon build reachability", () => {
  it("covers both variants without changing runtime variant selection", () => {
    expect(CENTRAL_ICON_DIRECTORIES).toEqual(["central-icons-reversed", "central-icons-fill"]);
    const sources = [
      '<CentralIcon name="heart" variant={variant} />',
      "const palette = ['star', 'rocket'];",
    ];
    for (const available of [
      new Set(["heart", "star", "rocket", "unused"]),
      new Set(["heart", "star", "rocket", "fill-only"]),
    ]) {
      expect([...collectReferencedCentralIcons(sources, available)]).toEqual([
        "heart",
        "star",
        "rocket",
      ]);
    }
  });

  it("accepts suffixes, template literals, direct URLs and CSS mask references", () => {
    const sources = [
      '<CentralIcon name="search.svg" />',
      "const name = `heart`;",
      'const icon = "/central-icons-fill/star.svg";',
      "mask: url('/central-icons-reversed/code-brackets.svg') center / contain;",
    ];
    expect([
      ...collectReferencedCentralIcons(
        sources,
        new Set(["search", "heart", "star", "code-brackets", "unused"]),
      ),
    ]).toEqual(["search", "heart", "star", "code-brackets"]);
  });

  it("preserves names that exist in only one variant and ignores unavailable names", () => {
    const sources = ['const icons = ["fill-only", "missing", "heart", "heart"];'];
    expect([...collectReferencedCentralIcons(sources, new Set(["fill-only", "heart"]))]).toEqual([
      "fill-only",
      "heart",
    ]);
  });

  it("returns an empty inventory so the build can fail open rather than remove every icon", () => {
    expect(collectReferencedCentralIcons([], new Set(["heart"])).size).toBe(0);
    expect(collectReferencedCentralIcons(['"heart"'], new Set()).size).toBe(0);
  });
});
