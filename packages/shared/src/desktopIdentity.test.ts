import { describe, expect, it } from "vitest";

import {
  desktopUpdateChannel,
  resolveSynaraDesktopFlavor,
  resolveSynaraDesktopRuntimeFlavor,
  canOverrideDesktopSmokeUserData,
  SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_BETA_DESKTOP_ENTRY_URL,
  SYNARA_BETA_DESKTOP_ORIGIN,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CANARY_DESKTOP_ENTRY_URL,
  SYNARA_CANARY_DESKTOP_ORIGIN,
  SYNARA_CUA_BUNDLE_ID,
  SYNARA_CUA_DESKTOP_ENTRY_URL,
  SYNARA_CUA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_ENTRY_URL,
  SYNARA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  synaraDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(SYNARA_PRODUCTION_BUNDLE_ID).toBe("com.emanueledipietro.synara");
    expect(SYNARA_DEVELOPMENT_BUNDLE_ID).toBe("com.emanueledipietro.synara.dev");
    expect(synaraDesktopIdentity("production").bundleId).toBe(SYNARA_PRODUCTION_BUNDLE_ID);
    expect(synaraDesktopIdentity("development").bundleId).toBe(SYNARA_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SYNARA_DESKTOP_ORIGIN).toBe("synara://app");
    expect(SYNARA_DESKTOP_ENTRY_URL).toBe("synara://app/index.html");
  });

  it("uses the isolated Synara desktop update channel", () => {
    expect(SYNARA_DESKTOP_UPDATE_CHANNEL).toBe("synara");
  });

  it("matches the beta update channel to prerelease tags and keeps synara otherwise", () => {
    expect(desktopUpdateChannel("beta")).toBe("beta");
    expect(desktopUpdateChannel("production")).toBe(SYNARA_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("canary")).toBe(SYNARA_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("development")).toBe(SYNARA_DESKTOP_UPDATE_CHANNEL);
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_CANARY_BUNDLE_ID).toBe("com.emanueledipietro.synara.canary");
    expect(SYNARA_CANARY_DESKTOP_ORIGIN).toBe("synara-canary://app");
    expect(SYNARA_CANARY_DESKTOP_ENTRY_URL).toBe("synara-canary://app/index.html");
    expect(synaraDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Synara Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: "synara-canary",
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      usesScriptedUpdates: true,
    });
  });

  it("gives Cua a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_CUA_BUNDLE_ID).toBe("com.emanueledipietro.synara.cua");
    expect(SYNARA_CUA_DESKTOP_ORIGIN).toBe("synara-cua://app");
    expect(SYNARA_CUA_DESKTOP_ENTRY_URL).toBe("synara-cua://app/index.html");
    expect(synaraDesktopIdentity("cua")).toEqual({
      flavor: "cua",
      displayName: "Synara Cua",
      bundleId: SYNARA_CUA_BUNDLE_ID,
      scheme: "synara-cua",
      origin: SYNARA_CUA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-cua",
      defaultHomeDirectoryName: ".synara-cua",
      usesScriptedUpdates: true,
    });
  });

  it("gives Beta a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_BETA_BUNDLE_ID).toBe("com.emanueledipietro.synara.beta");
    expect(SYNARA_BETA_DESKTOP_ORIGIN).toBe("synara-beta://app");
    expect(SYNARA_BETA_DESKTOP_ENTRY_URL).toBe("synara-beta://app/index.html");
    expect(synaraDesktopIdentity("beta")).toEqual({
      flavor: "beta",
      displayName: "Synara Beta",
      bundleId: SYNARA_BETA_BUNDLE_ID,
      scheme: "synara-beta",
      origin: SYNARA_BETA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-beta",
      defaultHomeDirectoryName: ".synara-beta",
      usesScriptedUpdates: false,
    });
  });

  it("selects explicit source flavors without changing packaged Stable", () => {
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(
      resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "development" }),
    ).toBe("production");
    expect(
      resolveSynaraDesktopFlavor({
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "cua" })).toBe(
      "cua",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "CUA" })).toBe("cua");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "beta" })).toBe(
      "beta",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: " beta " })).toBe(
      "beta",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "beta" })).toBe(
      "beta",
    );
  });

  it("isolates development and Canary homes from packaged Stable", () => {
    expect(synaraDesktopIdentity("development").defaultHomeDirectoryName).toBe(".synara-dev");
    expect(synaraDesktopIdentity("canary").defaultHomeDirectoryName).toBe(".synara-canary");
    expect(synaraDesktopIdentity("cua").defaultHomeDirectoryName).toBe(".synara-cua");
    expect(synaraDesktopIdentity("beta").defaultHomeDirectoryName).toBe(".synara-beta");
    expect(synaraDesktopIdentity("production").defaultHomeDirectoryName).toBe(".synara");
  });

  it.each(["production", "canary", "cua", "beta"] as const)(
    "uses the immutable %s package flavor despite inherited source settings",
    (packagedFlavor) => {
      expect(
        resolveSynaraDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: true,
          packagedFlavor,
          requestedFlavor: "development",
          allowDevelopmentOverride: true,
        }),
      ).toBe(packagedFlavor);
    },
  );

  it("keeps legacy packaged Stable independent from a source shell's flavor", () => {
    expect(
      resolveSynaraDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "cua",
      }),
    ).toBe("production");
  });

  it("preserves source launcher routing, including its bundled macOS bootstrap", () => {
    expect(
      resolveSynaraDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(
      resolveSynaraDesktopRuntimeFlavor({
        isPackaged: false,
        isDevelopment: true,
        requestedFlavor: "canary",
      }),
    ).toBe("canary");
  });

  it.each(["development", "CUA", "unknown", null, {}, 1])(
    "rejects malformed packaged identity %j before opening any profile",
    (packagedFlavor) => {
      expect(() =>
        resolveSynaraDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: false,
          packagedFlavor,
        }),
      ).toThrow("packaged Synara desktop flavor is invalid");
    },
  );

  it("isolates smoke profiles only for source launches or immutable Cua packages", () => {
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "cua" })).toBe(true);
    expect(
      canOverrideDesktopSmokeUserData({
        sourceBuildMarker: SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
      }),
    ).toBe(true);
    for (const packagedFlavor of ["production", "canary", "beta", "development", null]) {
      expect(
        canOverrideDesktopSmokeUserData({
          packagedFlavor,
          sourceBuildMarker: SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
        }),
      ).toBe(false);
    }
    expect(canOverrideDesktopSmokeUserData({})).toBe(false);
  });
});
