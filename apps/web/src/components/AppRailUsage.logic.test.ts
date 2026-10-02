import { describe, expect, it } from "vitest";

import {
  MAX_RAIL_USAGE_PROVIDERS,
  resolveRailUsageProviders,
  toggleRailUsageProvider,
} from "./AppRailUsage.logic";

describe("resolveRailUsageProviders", () => {
  it("drops duplicates and caps the selection", () => {
    const resolved = resolveRailUsageProviders(["codex", "codex", "claudeAgent", "cursor"]);
    expect(resolved).toEqual(["codex", "claudeAgent"]);
    expect(resolved.length).toBeLessThanOrEqual(MAX_RAIL_USAGE_PROVIDERS);
  });
});

describe("toggleRailUsageProvider", () => {
  it("adds a provider while there is room and removes it again", () => {
    expect(toggleRailUsageProvider(["codex"], "claudeAgent", true)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(toggleRailUsageProvider(["codex", "claudeAgent"], "codex", false)).toEqual([
      "claudeAgent",
    ]);
  });

  it("ignores a provider past the cap", () => {
    expect(toggleRailUsageProvider(["codex", "claudeAgent"], "cursor", true)).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });
});
