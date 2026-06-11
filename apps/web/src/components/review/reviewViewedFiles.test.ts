import type { ReviewTargetKey } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { reviewViewedStorageKey, toggleViewedPath } from "./reviewViewedFiles";

const TARGET: ReviewTargetKey = { _tag: "pullRequest", repositoryId: "repo123", number: 7 };

describe("toggleViewedPath", () => {
  it("adds a path that is not yet viewed", () => {
    expect([...toggleViewedPath(new Set(), "a.ts")]).toEqual(["a.ts"]);
  });

  it("removes a path that is already viewed", () => {
    expect([...toggleViewedPath(new Set(["a.ts", "b.ts"]), "a.ts")]).toEqual(["b.ts"]);
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a.ts"]);
    toggleViewedPath(input, "b.ts");
    expect([...input]).toEqual(["a.ts"]);
  });
});

describe("reviewViewedStorageKey", () => {
  it("is null without a target so the hook stays inert", () => {
    expect(reviewViewedStorageKey(null)).toBeNull();
  });

  it("derives a stable per-PR key from the canonical target identity", () => {
    const key = reviewViewedStorageKey(TARGET);
    expect(key).toMatch(/^review:viewed:/);
    expect(reviewViewedStorageKey(TARGET)).toBe(key);
  });
});
