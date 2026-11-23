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
  {
    // RFC #1301 P6: the server picks the sidekick by quota headroom at first
    // delegation and retargets it when the pinned provider's window closes.
    // `sidekick` stays set to the first candidate so non-auto paths and the
    // summary still have a concrete selection to show.
    id: "shipped:claude-leads-auto",
    name: "Claude leads Auto sidekick",
    pairing: {
      lead: { provider: "claudeAgent", instanceId: "claudeAgent", model: "claude-opus-5-5" },
      sidekick: { provider: "codex", instanceId: "codex", model: "gpt-5.4-mini" },
      autoSidekick: true,
      sidekickCandidates: [
        { provider: "codex", instanceId: "codex", model: "gpt-5.4-mini" },
        { provider: "claudeAgent", instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
        {
          provider: "grok",
          instanceId: "grok",
          model: "grok-4.6",
          options: { reasoningEffort: "low" },
        },
      ],
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
  return presets.flatMap((preset) => {
    if (!usableProviders.has(preset.pairing.lead.provider)) return [];
    if (preset.pairing.autoSidekick === true && preset.pairing.sidekickCandidates) {
      // An auto pairing is usable while at least one candidate resolves;
      // candidates a provider change broke are stripped, never offered.
      const candidates = preset.pairing.sidekickCandidates.filter((candidate) =>
        usableProviders.has(candidate.provider),
      );
      if (candidates.length === 0) return [];
      return [
        {
          ...preset,
          pairing: {
            ...preset.pairing,
            sidekick: candidates[0]!,
            sidekickCandidates: candidates,
          },
        },
      ];
    }
    return usableProviders.has(preset.pairing.sidekick.provider) ? [preset] : [];
  });
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
