import { describe, expect, it } from "vitest";

import { compareCodexCliVersions, parseCodexCliVersion } from "./codexCliVersion";

describe("Codex CLI prerelease versions", () => {
  it("preserves hyphens inside the prerelease suffix", () => {
    expect(parseCodexCliVersion("codex-cli 0.124.0-alpha-beta\n")).toBe(
      "0.124.0-alpha-beta",
    );
  });

  it("keeps distinct hyphenated prereleases distinct", () => {
    expect(compareCodexCliVersions("0.124.0-alpha-beta", "0.124.0-alpha-gamma")).toBeLessThan(0);
  });
});
