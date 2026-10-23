import { describe, expect, it } from "vitest";

import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { isBetaFeatureEnabled } from "@synara/shared/betaFeatures";

import { codeEditorEngine, visibleProviderDescriptors } from "./betaFeatures";

describe("visibleProviderDescriptors", () => {
  it("respects a disabled provider feature", () => {
    const visible = visibleProviderDescriptors((feature) => feature !== "omp");
    expect(visible.some((d) => d.kind === "omp")).toBe(false);
    expect(visible.map((d) => d.kind)).toEqual(
      PROVIDER_DESCRIPTORS.filter((d) => d.kind !== "omp").map((d) => d.kind),
    );
  });

  it("offers Oh My Pi and the other providers in Stable", () => {
    const visible = visibleProviderDescriptors((feature) =>
      isBetaFeatureEnabled(feature, "production"),
    );
    expect(visible).toEqual(PROVIDER_DESCRIPTORS);
  });
});

describe("codeEditorEngine", () => {
  it("keeps the Pierre engine on Stable and the native engine elsewhere", () => {
    expect(codeEditorEngine((feature) => isBetaFeatureEnabled(feature, "production"))).toBe(
      "pierre",
    );
    for (const flavor of ["beta", "canary", "development", "unknown"] as const) {
      expect(codeEditorEngine((feature) => isBetaFeatureEnabled(feature, flavor))).toBe("native");
    }
  });
});
