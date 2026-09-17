import { describe, expect, it } from "vitest";

import {
  resolveAuxiliaryContentProjectId,
  resolveAuxiliaryOpen,
  resolveAuxiliarySurface,
  resolveProjectPanelEnabled,
} from "./auxiliaryPanel.logic";

describe("auxiliary panel slot", () => {
  it("replaces the other surface and toggles the active icon closed", () => {
    expect(resolveAuxiliarySurface({ current: null, next: "project" })).toBe("project");
    expect(resolveAuxiliarySurface({ current: "environment", next: "project" })).toBe("project");
    expect(resolveAuxiliarySurface({ current: "project", next: "project" })).toBeNull();
  });

  it("hides Project for Chats and Studio containers", () => {
    expect(resolveProjectPanelEnabled({ environmentEnabled: true, isOrdinaryProject: false })).toBe(
      false,
    );
    expect(resolveProjectPanelEnabled({ environmentEnabled: true, isOrdinaryProject: true })).toBe(
      true,
    );
  });

  it("never displays another project's cached content", () => {
    expect(
      resolveAuxiliaryContentProjectId({
        focusedProjectId: "project-b",
        cachedProjectId: "project-a",
      }),
    ).toBe("project-b");
  });

  it("reports open only for the active surface", () => {
    expect(resolveAuxiliaryOpen({ surface: "project", requested: "project" })).toBe(true);
    expect(resolveAuxiliaryOpen({ surface: "project", requested: "environment" })).toBe(false);
  });
});
