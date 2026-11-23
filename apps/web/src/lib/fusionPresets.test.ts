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
