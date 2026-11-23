// FILE: useFusionPresets.ts
// Purpose: Saved (settings) + shipped Fusion pairing presets for the composer.
// Layer: Web hook — merges ServerSettings.fusionPresets with shipped defaults.

import { useQuery } from "@tanstack/react-query";
import type { FusionPairingPreset } from "@synara/contracts";
import { SHIPPED_FUSION_PRESETS } from "~/lib/fusionPresets";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";

// Saved pairings come first (RFC #1301 P5), shipped defaults after.
export function useFusionPresets(): ReadonlyArray<FusionPairingPreset> {
  const settings = useQuery(serverSettingsQueryOptions());
  return [...(settings.data?.fusionPresets ?? []), ...SHIPPED_FUSION_PRESETS];
}
