import path from "node:path";

import { expect, it } from "vitest";

import { isPathInside } from "./pathContainment";

it("accepts the parent and its descendants but not siblings that share a prefix", () => {
  const parent = path.resolve("workspace");
  expect(isPathInside(parent, parent)).toBe(true);
  expect(isPathInside(parent, path.join(parent, "src", "..x", "index.ts"))).toBe(true);
  expect(isPathInside(parent, path.join(parent, ".."))).toBe(false);
  expect(isPathInside(parent, `${parent}-sibling`)).toBe(false);
});
