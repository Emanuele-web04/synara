// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const SYNARA_DESKTOP_SCHEME = "synara";
export const SYNARA_DESKTOP_ORIGIN = `${SYNARA_DESKTOP_SCHEME}://app`;
export const SYNARA_DESKTOP_ENTRY_URL = `${SYNARA_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_DESKTOP_UPDATE_CHANNEL = "synara";
export const SYNARA_PRODUCTION_BUNDLE_ID = "com.emanueledipietro.synara";
export const SYNARA_DEVELOPMENT_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.dev`;
export const SYNARA_CANARY_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.canary`;
/** Display/setup identity of the GUI host; this value does not confer native authority. */
export const SYNARA_DESKTOP_BUNDLE_ID_ENV = "SYNARA_DESKTOP_BUNDLE_ID";
export const SYNARA_CANARY_DESKTOP_SCHEME = "synara-canary";
export const SYNARA_CANARY_DESKTOP_ORIGIN = `${SYNARA_CANARY_DESKTOP_SCHEME}://app`;
export const SYNARA_CANARY_DESKTOP_ENTRY_URL = `${SYNARA_CANARY_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_CUA_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.cua`;
export const SYNARA_CUA_DESKTOP_SCHEME = "synara-cua";
export const SYNARA_CUA_DESKTOP_ORIGIN = `${SYNARA_CUA_DESKTOP_SCHEME}://app`;
export const SYNARA_CUA_DESKTOP_ENTRY_URL = `${SYNARA_CUA_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_BETA_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.beta`;
export const SYNARA_BETA_DESKTOP_SCHEME = "synara-beta";
export const SYNARA_BETA_DESKTOP_ORIGIN = `${SYNARA_BETA_DESKTOP_SCHEME}://app`;
export const SYNARA_BETA_DESKTOP_ENTRY_URL = `${SYNARA_BETA_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_SOURCE_DESKTOP_BUILD_MARKER = "synara-source-desktop-build-v2";
export const SYNARA_DESKTOP_SMOKE_USER_DATA_ENV = "SYNARA_DESKTOP_SMOKE_USER_DATA";

export type SynaraDesktopFlavor = "production" | "development" | "canary" | "cua" | "beta";
export const SYNARA_PACKAGED_DESKTOP_FLAVORS = ["production", "canary", "cua", "beta"] as const;
export type SynaraPackagedDesktopFlavor = (typeof SYNARA_PACKAGED_DESKTOP_FLAVORS)[number];

/**
 * electron-updater matches the update channel against the release tag's
 * prerelease identifier, so the beta flavor must use the `beta` channel to see
 * `vX.Y.Z-beta.N` releases. Every other flavor keeps the `synara` channel.
 */
export function desktopUpdateChannel(flavor: SynaraDesktopFlavor): string {
  return flavor === "beta" ? "beta" : SYNARA_DESKTOP_UPDATE_CHANNEL;
}

export interface SynaraDesktopIdentity {
  readonly flavor: SynaraDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  readonly usesScriptedUpdates: boolean;
}

export function resolveSynaraDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): SynaraDesktopFlavor {
  const requestedFlavor = input.requestedFlavor?.trim().toLowerCase();
  if (requestedFlavor === "cua") {
    return "cua";
  }
  if (requestedFlavor === "canary") {
    return "canary";
  }
  if (requestedFlavor === "beta") {
    return "beta";
  }
  if (
    requestedFlavor === "development" &&
    (input.isDevelopment || input.allowDevelopmentOverride === true)
  ) {
    return "development";
  }
  return input.isDevelopment ? "development" : "production";
}

/** Packaged identity is fixed when the artifact is staged, before it is signed. */
export function resolveSynaraDesktopRuntimeFlavor(input: {
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly packagedFlavor?: unknown;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): SynaraDesktopFlavor {
  if (input.isPackaged && input.packagedFlavor !== undefined) {
    const flavor = input.packagedFlavor;
    if (
      flavor === "production" ||
      flavor === "canary" ||
      flavor === "cua" ||
      flavor === "beta"
    ) {
      return flavor;
    }
    throw new Error("The packaged Synara desktop flavor is invalid. Rebuild the application.");
  }
  // Source launchers also use an app bundle on macOS. Their build marker keeps
  // the existing environment-based routing, while legacy packaged apps remain
  // Stable even when a developer shell happens to export a different flavor.
  if (input.isPackaged && input.allowDevelopmentOverride !== true) {
    return "production";
  }
  return resolveSynaraDesktopFlavor(input);
}

export function canOverrideDesktopSmokeUserData(input: {
  readonly packagedFlavor?: unknown;
  readonly sourceBuildMarker?: string | undefined;
}): boolean {
  return (
    input.packagedFlavor === "cua" ||
    (input.packagedFlavor === undefined &&
      input.sourceBuildMarker === SYNARA_SOURCE_DESKTOP_BUILD_MARKER)
  );
}

export function synaraDesktopIdentity(flavor: SynaraDesktopFlavor): SynaraDesktopIdentity {
  if (flavor === "cua") {
    return {
      flavor,
      displayName: "Synara Cua",
      bundleId: SYNARA_CUA_BUNDLE_ID,
      scheme: SYNARA_CUA_DESKTOP_SCHEME,
      origin: SYNARA_CUA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-cua",
      defaultHomeDirectoryName: ".synara-cua",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "Synara Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: SYNARA_CANARY_DESKTOP_SCHEME,
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "beta") {
    return {
      flavor,
      displayName: "Synara Beta",
      bundleId: SYNARA_BETA_BUNDLE_ID,
      scheme: SYNARA_BETA_DESKTOP_SCHEME,
      origin: SYNARA_BETA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-beta",
      defaultHomeDirectoryName: ".synara-beta",
      usesScriptedUpdates: false,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "Synara (Dev)",
      bundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      scheme: SYNARA_DESKTOP_SCHEME,
      origin: SYNARA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-dev",
      defaultHomeDirectoryName: ".synara-dev",
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "Synara",
    bundleId: SYNARA_PRODUCTION_BUNDLE_ID,
    scheme: SYNARA_DESKTOP_SCHEME,
    origin: SYNARA_DESKTOP_ORIGIN,
    entryUrl: SYNARA_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "synara",
    defaultHomeDirectoryName: ".synara",
    usesScriptedUpdates: false,
  };
}
