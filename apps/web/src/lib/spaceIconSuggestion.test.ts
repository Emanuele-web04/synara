import { SPACE_ICON_NAMES } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { suggestSpaceIcon } from "./spaceIconSuggestion";

describe("suggestSpaceIcon", () => {
  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(suggestSpaceIcon("  LAVORO  ")).toBe("bag");
  });

  it("falls back deterministically for names with no keyword match", () => {
    const first = suggestSpaceIcon("Zzyzx");
    expect(SPACE_ICON_NAMES).toContain(first);
    expect(suggestSpaceIcon("Zzyzx")).toBe(first);
  });

  it("returns the default icon for empty input", () => {
    expect(suggestSpaceIcon("")).toBe(SPACE_ICON_NAMES[0]);
    expect(suggestSpaceIcon("   ")).toBe(SPACE_ICON_NAMES[0]);
  });
});
