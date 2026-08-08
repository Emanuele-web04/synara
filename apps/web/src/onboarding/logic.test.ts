import { describe, expect, it } from "vitest";

import {
  defaultCandidateSelection,
  nextOnboardingStep,
  ONBOARDING_STEPS,
  previousOnboardingStep,
  resolveOnboardingGate,
  summarizeThreadImports,
  toggleSelection,
} from "./logic";

describe("resolveOnboardingGate", () => {
  const freshInstall = {
    threadsHydrated: true,
    settingsSettled: true,
    projectCount: 0,
    serverCompletedAt: null,
    localCompletedAt: null,
  };

  it("stays pending until hydration and settings settle", () => {
    expect(resolveOnboardingGate({ ...freshInstall, threadsHydrated: false })).toBe("pending");
    expect(resolveOnboardingGate({ ...freshInstall, settingsSettled: false })).toBe("pending");
  });

  it("shows only on a true fresh install", () => {
    expect(resolveOnboardingGate(freshInstall)).toBe("show");
    expect(resolveOnboardingGate({ ...freshInstall, projectCount: 3 })).toBe("hidden");
    expect(
      resolveOnboardingGate({ ...freshInstall, serverCompletedAt: "2026-08-01T00:00:00.000Z" }),
    ).toBe("hidden");
    expect(
      resolveOnboardingGate({ ...freshInstall, localCompletedAt: "2026-08-01T00:00:00.000Z" }),
    ).toBe("hidden");
  });
});

describe("step navigation", () => {
  it("walks forward and backward within bounds", () => {
    expect(nextOnboardingStep("welcome")).toBe("providers");
    expect(nextOnboardingStep("threads")).toBe("done");
    expect(nextOnboardingStep("done")).toBe("done");
    expect(previousOnboardingStep("providers")).toBe("welcome");
    expect(previousOnboardingStep("welcome")).toBe("welcome");
    expect(ONBOARDING_STEPS).toHaveLength(5);
  });
});

describe("selection helpers", () => {
  it("default-selects candidates that are not already projects", () => {
    const selection = defaultCandidateSelection([
      { workspaceRoot: "/a", existingProjectId: null },
      { workspaceRoot: "/b", existingProjectId: "project-1" },
      { workspaceRoot: "/c", existingProjectId: null },
    ]);
    expect([...selection].toSorted()).toEqual(["/a", "/c"]);
  });

  it("toggles ids immutably", () => {
    const initial = new Set(["a"]);
    const added = toggleSelection(initial, "b");
    expect([...added].toSorted()).toEqual(["a", "b"]);
    expect([...initial]).toEqual(["a"]);
    expect([...toggleSelection(added, "a")]).toEqual(["b"]);
  });
});

describe("summarizeThreadImports", () => {
  it("counts imported and failed results", () => {
    expect(
      summarizeThreadImports([
        { sessionId: "a", status: "imported" },
        { sessionId: "b", status: "failed", message: "boom" },
        { sessionId: "c", status: "imported" },
      ]),
    ).toEqual({ imported: 2, failed: 1 });
  });
});
