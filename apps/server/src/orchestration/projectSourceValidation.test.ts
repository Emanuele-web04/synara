// FILE: projectSourceValidation.test.ts
// Purpose: Covers validation for ordered multi-folder project source sets.
// Layer: Server orchestration tests
// Exports: Vitest cases for validateProjectSources.

import { ProjectSourceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { validateProjectSources } from "./projectSourceValidation.ts";

const asSourceId = (value: string): ProjectSourceId => ProjectSourceId.makeUnsafe(value);

describe("validateProjectSources", () => {
  it("accepts distinct absolute sources with a primary inside the set", () => {
    expect(
      validateProjectSources(
        [
          { id: asSourceId("source-primary"), path: "/tmp/primary" },
          { id: asSourceId("source-docs"), path: "/tmp/docs" },
        ],
        asSourceId("source-primary"),
      ),
    ).toBeNull();
  });

  it("rejects an empty source set", () => {
    expect(validateProjectSources([], asSourceId("source-primary"))).toContain("at least one");
  });

  it("rejects relative paths", () => {
    expect(
      validateProjectSources(
        [{ id: asSourceId("source-primary"), path: "relative/folder" }],
        asSourceId("source-primary"),
      ),
    ).toContain("absolute path");
  });

  it("rejects duplicate normalized paths", () => {
    expect(
      validateProjectSources(
        [
          { id: asSourceId("source-primary"), path: "/tmp/primary" },
          { id: asSourceId("source-copy"), path: "/tmp/primary/" },
        ],
        asSourceId("source-primary"),
      ),
    ).toContain("Duplicate source folder");
  });

  it("rejects duplicate source ids even when the paths differ", () => {
    expect(
      validateProjectSources(
        [
          { id: asSourceId("source-primary"), path: "/tmp/primary" },
          { id: asSourceId("source-primary"), path: "/tmp/other" },
        ],
        asSourceId("source-primary"),
      ),
    ).toBe("Duplicate source id: source-primary");
  });

  it("rejects a primary source id outside the set", () => {
    expect(
      validateProjectSources(
        [{ id: asSourceId("source-primary"), path: "/tmp/primary" }],
        asSourceId("source-missing"),
      ),
    ).toContain("primary source folder");
  });
});
