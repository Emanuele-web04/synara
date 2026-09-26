// FILE: betaFeatures.ts
// Purpose: The web app's read of the shared Beta-only feature list.
// Layer: Route/UI support
// Exports: isBetaFeatureOn, visibleProviderDescriptors, VISIBLE_PROVIDER_DESCRIPTORS

import { desktopFlavorFromProtocol, isBetaFeatureEnabled } from "@synara/shared/betaFeatures";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";

// The desktop serves the app from its own scheme, so the protocol names the
// host flavor (branding.ts uses the same signal for display names). A dev
// build serves `synara:` too, so import.meta.env.DEV disambiguates it. SSR and
// tests have no window and resolve to "unknown", which keeps Beta-only
// features on — the server gate is the authoritative one.
const DESKTOP_FLAVOR = desktopFlavorFromProtocol(
  typeof window === "undefined" ? undefined : window.location?.protocol,
  import.meta.env.DEV,
);

export const isBetaFeatureOn = (feature: string): boolean =>
  isBetaFeatureEnabled(feature, DESKTOP_FLAVOR);

/**
 * Provider descriptors with Beta-only providers removed on Stable. A
 * provider's feature key is its ProviderKind, so an unlisted kind is always
 * visible. Selectable lists (pickers, settings, onboarding) consume this;
 * display-only rendering of existing threads keeps PROVIDER_DESCRIPTORS.
 */
export function visibleProviderDescriptors(
  isOn: (feature: string) => boolean = isBetaFeatureOn,
): (typeof PROVIDER_DESCRIPTORS)[number][] {
  return PROVIDER_DESCRIPTORS.filter((d) => isOn(d.kind));
}

export const VISIBLE_PROVIDER_DESCRIPTORS = visibleProviderDescriptors();
