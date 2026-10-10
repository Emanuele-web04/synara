import { describe, expect, it } from "vitest";

import { resolveCatalogDependencies } from "./resolve-catalog.ts";

describe("resolveCatalogDependencies", () => {
  it("resolves scoped override catalogs for the dependency while preserving the selector", () => {
    expect(
      resolveCatalogDependencies(
        { "@effect/platform-node>effect": "catalog:", effect: "catalog:", other: "2.0.0" },
        { effect: "https://example.test/effect.tgz" },
        "desktop overrides",
      ),
    ).toEqual({
      "@effect/platform-node>effect": "https://example.test/effect.tgz",
      effect: "https://example.test/effect.tgz",
      other: "2.0.0",
    });
  });
});
