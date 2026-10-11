// FILE: betaFeatureGate.ts
// Purpose: The server's read of the shared Beta-only feature list.
// Layer: Runtime gate (consumed by settings projection and provider messaging)
// Exports: SERVER_DESKTOP_FLAVOR, isServerBetaFeatureEnabled

import { desktopFlavorFromBundleId, isBetaFeatureEnabled } from "@synara/shared/betaFeatures";
import { SYNARA_DESKTOP_BUNDLE_ID_ENV } from "@synara/shared/desktopIdentity";

/** The hosting desktop's flavor; "unknown" (non-desktop hosts) keeps Beta-only features on. */
export const SERVER_DESKTOP_FLAVOR = desktopFlavorFromBundleId(
  process.env[SYNARA_DESKTOP_BUNDLE_ID_ENV],
);

export const isServerBetaFeatureEnabled = (feature: string): boolean =>
  isBetaFeatureEnabled(feature, SERVER_DESKTOP_FLAVOR);
