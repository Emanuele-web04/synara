// FILE: betaFeatures.ts
// Purpose: The web app's read of the shared Beta-only feature list.
// Layer: Route/UI support
// Exports: COMPUTER_USE_ENABLED

import {
  desktopFlavorFromProtocol,
  isBetaFeatureEnabled,
} from "@synara/shared/betaFeatures";

// The desktop serves the app from its own scheme, so the protocol names the
// host flavor (branding.ts uses the same signal for display names). A dev
// build serves `synara:` too, so import.meta.env.DEV disambiguates it. SSR and
// tests have no window and resolve to "unknown", which keeps Beta-only
// features on — the server gate is the authoritative one.
export const COMPUTER_USE_ENABLED = isBetaFeatureEnabled(
  "computerUse",
  desktopFlavorFromProtocol(
    typeof window === "undefined" ? undefined : window.location?.protocol,
    import.meta.env.DEV,
  ),
);
