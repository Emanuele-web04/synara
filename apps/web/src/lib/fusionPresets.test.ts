import { describe, expect, it } from "vitest";

import type { FusionPairingPreset } from "@synara/contracts";

import { fusionPresetSummary, SHIPPED_FUSION_PRESETS, usableFusionPresets } from "./fusionPresets";

const preset = (id: string, leadProvider: string, sidekickProvider: string): FusionPairingPreset =>
  ({
    id,
    name: id,
    pairing: {
      lead: { provider: leadProvider, instanceId: leadProvider, model: "m" },
      sidekick: { provider: sidekickProvider, instanceId: sidekickProvider, model: "m" },
    },
  }) as FusionPairingPreset;

describe("usableFusionPresets", () => {
  it("keeps presets whose providers are both usable", () => {
    const presets = [preset("a", "claudeAgent", "codex"), preset("b", "claudeAgent", "grok")];
    const usable = usableFusionPresets(presets, new Set(["claudeAgent", "codex"]));
    expect(usable.map((p) => p.id)).toEqual(["a"]);
  });

  it("returns every shipped preset when all providers are usable", () => {
    const usable = usableFusionPresets(
      SHIPPED_FUSION_PRESETS,
      new Set(["claudeAgent", "codex", "grok"]),
    );
    expect(usable).toHaveLength(SHIPPED_FUSION_PRESETS.length);
  });

  it("strips unusable candidates from an auto preset and keeps the rest", () => {
    const auto = {
      ...preset("auto", "claudeAgent", "codex"),
      pairing: {
        ...preset("auto", "claudeAgent", "codex").pairing,
        autoSidekick: true,
        sidekickCandidates: [
          { provider: "codex", instanceId: "codex", model: "m" },
          { provider: "grok", instanceId: "grok", model: "m" },
        ],
      },
    } as FusionPairingPreset;
    const usable = usableFusionPresets([auto], new Set(["claudeAgent", "grok"]));
    expect(usable).toHaveLength(1);
    expect(usable[0]?.pairing.sidekickCandidates?.map((c) => c.provider)).toEqual(["grok"]);
    expect(usable[0]?.pairing.sidekick.provider).toBe("grok");
  });

  it("drops an auto preset when no candidate is usable", () => {
    const auto = {
      ...preset("auto", "claudeAgent", "codex"),
      pairing: {
        ...preset("auto", "claudeAgent", "codex").pairing,
        autoSidekick: true,
        sidekickCandidates: [
          { provider: "codex", instanceId: "codex", model: "m" },
          { provider: "grok", instanceId: "grok", model: "m" },
        ],
      },
    } as FusionPairingPreset;
    expect(usableFusionPresets([auto], new Set(["claudeAgent"]))).toHaveLength(0);
  });
});

describe("fusionPresetSummary", () => {
  it("renders lead and sidekick display names", () => {
    const summary = fusionPresetSummary(
      preset("a", "claudeAgent", "codex"),
      (_provider, model) => `name:${model}`,
    );
    expect(summary).toBe("name:m → name:m");
  });
});
