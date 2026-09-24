import { describe, expect, it } from "vitest";

import {
  BETA_ONLY_FEATURES,
  desktopFlavorFromBundleId,
  desktopFlavorFromProtocol,
  isBetaFeatureEnabled,
} from "./betaFeatures";
import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CUA_BUNDLE_ID,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "./desktopIdentity";

describe("isBetaFeatureEnabled", () => {
  it("enables every feature everywhere while the list is empty", () => {
    for (const flavor of [
      "development",
      "canary",
      "cua",
      "beta",
      "unknown",
      "production",
    ] as const) {
      expect(isBetaFeatureEnabled("computerUse", flavor)).toBe(true);
    }
  });

  it("keeps the gate list empty until a feature opts in", () => {
    // The list is the whole gate: a feature not present is enabled everywhere,
    // which is also the steady state once a feature is promoted to Stable.
    expect(BETA_ONLY_FEATURES).not.toContain("computerUse");
  });
});

describe("desktopFlavorFromBundleId", () => {
  it("maps each known bundle id", () => {
    expect(desktopFlavorFromBundleId(SYNARA_PRODUCTION_BUNDLE_ID)).toBe("production");
    expect(desktopFlavorFromBundleId(SYNARA_DEVELOPMENT_BUNDLE_ID)).toBe("development");
    expect(desktopFlavorFromBundleId(SYNARA_CANARY_BUNDLE_ID)).toBe("canary");
    expect(desktopFlavorFromBundleId(SYNARA_CUA_BUNDLE_ID)).toBe("cua");
    expect(desktopFlavorFromBundleId(SYNARA_BETA_BUNDLE_ID)).toBe("beta");
  });

  it("trims surrounding whitespace", () => {
    expect(desktopFlavorFromBundleId(` ${SYNARA_BETA_BUNDLE_ID} `)).toBe("beta");
  });

  it("returns unknown for blank or unrecognized ids", () => {
    expect(desktopFlavorFromBundleId(undefined)).toBe("unknown");
    expect(desktopFlavorFromBundleId("")).toBe("unknown");
    expect(desktopFlavorFromBundleId("   ")).toBe("unknown");
    expect(desktopFlavorFromBundleId("com.example.other")).toBe("unknown");
  });
});

describe("desktopFlavorFromProtocol", () => {
  it("maps each desktop scheme", () => {
    expect(desktopFlavorFromProtocol("synara-beta:", false)).toBe("beta");
    expect(desktopFlavorFromProtocol("synara-canary:", false)).toBe("canary");
    expect(desktopFlavorFromProtocol("synara-cua:", false)).toBe("cua");
    expect(desktopFlavorFromProtocol("synara:", false)).toBe("production");
  });

  it("treats the synara scheme in a dev build as development", () => {
    expect(desktopFlavorFromProtocol("synara:", true)).toBe("development");
  });

  it("returns unknown for non-desktop protocols and missing values", () => {
    expect(desktopFlavorFromProtocol("http:", false)).toBe("unknown");
    expect(desktopFlavorFromProtocol("https:", true)).toBe("unknown");
    expect(desktopFlavorFromProtocol(undefined, false)).toBe("unknown");
  });
});
