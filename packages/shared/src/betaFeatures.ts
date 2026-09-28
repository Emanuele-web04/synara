// FILE: betaFeatures.ts
// Purpose: The single list of features that ship in Beta but not in Stable.
// Layer: Shared contracts (consumed by desktop main, server, and web UI)

import {
  SYNARA_BETA_BUNDLE_ID,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CUA_BUNDLE_ID,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  type SynaraDesktopFlavor,
} from "./desktopIdentity";

/**
 * Features that ship only in non-Stable builds. Keep a feature out of Stable
 * by adding its key here; promote it by deleting the entry. A provider's key
 * is its ProviderKind: today that is "omp" only.
 */
export type BetaOnlyFeature = string;
export const BETA_ONLY_FEATURES: readonly BetaOnlyFeature[] = ["omp"];

/**
 * Whether a Beta-only feature is on for this host. Only the Stable
 * (production) desktop build turns them off: Beta, Cua, Canary, development
 * and non-desktop hosts (flavor "unknown") keep them.
 */
export function isBetaFeatureEnabled(
  feature: BetaOnlyFeature,
  flavor: SynaraDesktopFlavor | "unknown",
): boolean {
  return !BETA_ONLY_FEATURES.includes(feature) || flavor !== "production";
}

/** Maps a desktop bundle id to its flavor; blank or unrecognized -> "unknown". */
export function desktopFlavorFromBundleId(
  bundleId: string | undefined,
): SynaraDesktopFlavor | "unknown" {
  switch (bundleId?.trim()) {
    case SYNARA_PRODUCTION_BUNDLE_ID:
      return "production";
    case SYNARA_DEVELOPMENT_BUNDLE_ID:
      return "development";
    case SYNARA_CANARY_BUNDLE_ID:
      return "canary";
    case SYNARA_CUA_BUNDLE_ID:
      return "cua";
    case SYNARA_BETA_BUNDLE_ID:
      return "beta";
    default:
      return "unknown";
  }
}

/**
 * Maps the web app's own URL scheme to the hosting desktop's flavor. A Stable
 * build serves `synara:` pages; a development build serves the same scheme, so
 * the caller passes whether this is a dev build. Anything else (http, missing
 * window) is "unknown".
 */
export function desktopFlavorFromProtocol(
  protocol: string | undefined,
  isDevBuild: boolean,
): SynaraDesktopFlavor | "unknown" {
  switch (protocol) {
    case "synara-beta:":
      return "beta";
    case "synara-canary:":
      return "canary";
    case "synara-cua:":
      return "cua";
    case "synara:":
      return isDevBuild ? "development" : "production";
    default:
      return "unknown";
  }
}
