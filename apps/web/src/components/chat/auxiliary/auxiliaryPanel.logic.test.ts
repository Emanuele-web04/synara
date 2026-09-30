import { describe, expect, it } from "vitest";

import { resolveAuxiliarySurface, resolveProjectPanelEnabled } from "./auxiliaryPanel.logic";

describe("auxiliary panel slot", () => {
  it("shows Project only for group containers", () => {
    expect(resolveProjectPanelEnabled({ environmentEnabled: true, isGroupContainer: true })).toBe(
      true,
    );
    expect(resolveProjectPanelEnabled({ environmentEnabled: true, isGroupContainer: false })).toBe(
      false,
    );
    expect(resolveProjectPanelEnabled({ environmentEnabled: false, isGroupContainer: true })).toBe(
      false,
    );
  });
});

describe("resolveAuxiliarySurface", () => {
  const base = {
    choice: null,
    projectId: "project-1",
    projectPanelEnabled: true,
    environmentPanelVisible: true,
    groupPanelClosed: false,
  } as const;

  it("defaults a group chat to the project surface", () => {
    expect(resolveAuxiliarySurface(base)).toBe("project");
  });

  it("respects a persisted close for the group", () => {
    expect(resolveAuxiliarySurface({ ...base, groupPanelClosed: true })).toBe("environment");
    expect(
      resolveAuxiliarySurface({
        ...base,
        groupPanelClosed: true,
        environmentPanelVisible: false,
      }),
    ).toBeNull();
  });

  it("falls back to the environment surface outside groups", () => {
    expect(resolveAuxiliarySurface({ ...base, projectPanelEnabled: false })).toBe("environment");
    expect(
      resolveAuxiliarySurface({
        ...base,
        projectPanelEnabled: false,
        environmentPanelVisible: false,
      }),
    ).toBeNull();
  });

  it("applies an explicit choice while its project stays active", () => {
    expect(
      resolveAuxiliarySurface({
        ...base,
        choice: { projectId: "project-1", surface: "environment" },
      }),
    ).toBe("environment");
    // An explicit "closed" beats the group default too.
    expect(
      resolveAuxiliarySurface({ ...base, choice: { projectId: "project-1", surface: null } }),
    ).toBeNull();
  });

  it("ignores a choice scoped to another project", () => {
    expect(
      resolveAuxiliarySurface({
        ...base,
        choice: { projectId: "project-2", surface: "environment" },
      }),
    ).toBe("project");
  });

  it("never surfaces project/library where the panel is disabled", () => {
    expect(
      resolveAuxiliarySurface({
        ...base,
        projectPanelEnabled: false,
        choice: { projectId: "project-1", surface: "project" },
      }),
    ).toBeNull();
    expect(
      resolveAuxiliarySurface({
        ...base,
        projectPanelEnabled: false,
        choice: { projectId: "project-1", surface: "library" },
      }),
    ).toBeNull();
  });
});
