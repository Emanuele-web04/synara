// FILE: fusionPresets.ts
// Purpose: Shipped Fusion pairing defaults + usability resolution (RFC #1301 P5).
// Layer: Web lib — presets are a composer/settings concern; the server only
//        persists the user's saved list.

import type { FusionPairingPreset, ProviderKind } from "@synara/contracts";

// A few shipped pairings the RFC names explicitly. Lead is the frontier model;
// sidekick is the cheaper executor on the same or another provider.
export const SHIPPED_FUSION_PRESETS: ReadonlyArray<FusionPairingPreset> = [
  {
    id: "shipped:claude-leads-codex",
    name: "Claude leads Codex",
    pairing: {
      lead: { provider: "claudeAgent", instanceId: "claudeAgent", model: "claude-opus-5-5" },
      sidekick: { provider: "codex", instanceId: "codex", model: "gpt-5.4-mini" },
    },
  },
  {
    id: "shipped:codex-high-leads-codex-medium",
    name: "Codex high leads Codex medium",
    pairing: {
      lead: {
        provider: "codex",
        instanceId: "codex",
        model: "gpt-6-astra",
        options: { reasoningEffort: "high" },
      },
      sidekick: {
        provider: "codex",
        instanceId: "codex",
        model: "gpt-6-astra",
        options: { reasoningEffort: "medium" },
      },
    },
  },
  {
    id: "shipped:claude-leads-grok",
    name: "Claude leads Grok fast",
    pairing: {
      lead: { provider: "claudeAgent", instanceId: "claudeAgent", model: "claude-opus-5-5" },
      sidekick: {
        provider: "grok",
        instanceId: "grok",
        model: "grok-4.6",
        options: { reasoningEffort: "low" },
      },
    },
  },
];

/**
 * Presets usable right now: both roles resolve to a provider the picker can
 * actually serve (an enabled account with no setup blocker). Saved presets a
 * provider change breaks stay in settings — they just stop being offered.
 */
export function usableFusionPresets(
  presets: ReadonlyArray<FusionPairingPreset>,
  usableProviders: ReadonlySet<ProviderKind>,
): FusionPairingPreset[] {
  return presets.filter(
    (preset) =>
      usableProviders.has(preset.pairing.lead.provider) &&
      usableProviders.has(preset.pairing.sidekick.provider),
  );
}

/** One-line "lead · model → sidekick · model" summary for rows and settings. */
export function fusionPresetSummary(
  preset: FusionPairingPreset,
  modelName: (provider: ProviderKind, model: string) => string,
): string {
  const lead = `${modelName(preset.pairing.lead.provider, preset.pairing.lead.model)}`;
  const sidekick = `${modelName(preset.pairing.sidekick.provider, preset.pairing.sidekick.model)}`;
  return `${lead} → ${sidekick}`;
}
