import { describe, expect, it } from "vitest";

import {
  desktopUpdateChannel,
  resolveSynaraDesktopFlavor,
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_BETA_DESKTOP_ENTRY_URL,
  SYNARA_BETA_DESKTOP_ORIGIN,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CANARY_DESKTOP_ENTRY_URL,
  SYNARA_CANARY_DESKTOP_ORIGIN,
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
    expect(synaraDesktopIdentity("beta").defaultHomeDirectoryName).toBe(".synara-beta");
    expect(synaraDesktopIdentity("production").defaultHomeDirectoryName).toBe(".synara");
  });
});
