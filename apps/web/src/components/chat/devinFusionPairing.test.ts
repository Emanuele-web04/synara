import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildDevinPairingPatch,
  currentDevinPairing,
  devinPairingLeadEfforts,
  devinPairingLeadHasFast,
  devinPairingSidekicksForLead,
  devinPairingStatusLabel,
  getDevinPairingModel,
  resolveDevinPairingUid,
} from "./devinFusionPairing";

function fusionRuntimeModel(): ProviderModelDescriptor {
  return {
    slug: "fusion",
    name: "Fusion",
    modelVariants: [
      {
        model: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
        label: "Fusion (Claude Fable 5.1 High + SWE-2 Medium)",
      },
      {
        model: "fusion-claude-fable-5-1-high-fast-sidekick-swe-2-medium",
        label: "Fusion (Claude Fable 5.1 High Fast + SWE-2 Medium)",
      },
      {
        model: "fusion-claude-fable-5-1-low-sidekick-swe-2-medium",
        label: "Fusion (Claude Fable 5.1 Low + SWE-2 Medium)",
      },
      {
        model: "fusion-claude-fable-5-1-high-sidekick-claude-sonnet-5-5-medium",
        label: "Fusion (Claude Fable 5.1 High + Claude Sonnet 5.5 Medium)",
      },
      {
        model: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
        label: "Fusion (GPT-6 Sol Extra High Thinking + GLM-5.2)",
      },
    ],
  };
}

describe("getDevinPairingModel", () => {
  it("detects pairing families by their -sidekick- variant shape", () => {
    const pairing = getDevinPairingModel("devin", fusionRuntimeModel());
    expect(pairing).not.toBeNull();
    expect(pairing?.leads.map((lead) => lead.value)).toEqual(["claude-fable-5-1", "gpt-6-sol"]);
    expect(pairing?.leads[0]?.label).toBe("Claude Fable 5.1");
    expect(pairing?.sidekicks.map((sidekick) => sidekick.value)).toEqual([
      "swe-2-medium",
      "claude-sonnet-5-5-medium",
      "glm-5-2",
    ]);
    // Provider labels keep the CLI's own casing for the sidekick half.
    expect(pairing?.sidekicks[0]?.label).toBe("SWE-2 Medium");
  });

  it("rejects non-Devin providers and models without pairing variants", () => {
    expect(getDevinPairingModel("codex", fusionRuntimeModel())).toBeNull();
    expect(getDevinPairingModel("devin", undefined)).toBeNull();
    expect(
      getDevinPairingModel("devin", { slug: "swe-2", name: "SWE-2", modelVariants: [] }),
    ).toBeNull();
    expect(
      getDevinPairingModel("devin", {
        slug: "swe-2",
        name: "SWE-2",
        modelVariants: [{ model: "swe-2-high" }, { model: "swe-2-medium" }],
      }),
    ).toBeNull();
  });

  it("falls back to a composed label when the provider sends none", () => {
    const pairing = getDevinPairingModel("devin", {
      slug: "fusion",
      name: "Fusion",
      modelVariants: [{ model: "fusion-claude-fable-5-1-high-fast-sidekick-swe-2-medium" }],
    });
    expect(pairing?.variants[0]?.label).toBe("Claude Fable 5.1 High Fast + SWE 2 Medium");
  });
});

describe("devinPairingLeadEfforts / sidekicksForLead / leadHasFast", () => {
  const pairing = getDevinPairingModel("devin", fusionRuntimeModel());

  it("lists the lead's efforts in canonical order", () => {
    expect(devinPairingLeadEfforts(pairing!, "claude-fable-5-1").map((o) => o.value)).toEqual([
      "low",
      "high",
    ]);
    expect(devinPairingLeadEfforts(pairing!, "gpt-6-sol").map((o) => o.value)).toEqual(["xhigh"]);
  });

  it("scopes sidekicks to the selected lead", () => {
    expect(devinPairingSidekicksForLead(pairing!, "claude-fable-5-1").map((o) => o.value)).toEqual([
      "swe-2-medium",
      "claude-sonnet-5-5-medium",
    ]);
    expect(devinPairingSidekicksForLead(pairing!, "gpt-6-sol").map((o) => o.value)).toEqual([
      "glm-5-2",
    ]);
  });

  it("reports fast support per lead", () => {
    expect(devinPairingLeadHasFast(pairing!, "claude-fable-5-1")).toBe(true);
    expect(devinPairingLeadHasFast(pairing!, "gpt-6-sol")).toBe(false);
  });
});

describe("resolveDevinPairingUid", () => {
  const pairing = getDevinPairingModel("devin", fusionRuntimeModel())!;

  it("returns the exact UID for a complete selection", () => {
    expect(
      resolveDevinPairingUid(pairing, {
        lead: "claude-fable-5-1",
        effort: "high",
        fast: false,
        sidekick: "claude-sonnet-5-5-medium",
      }),
    ).toBe("fusion-claude-fable-5-1-high-sidekick-claude-sonnet-5-5-medium");
  });

  it("relaxes the sidekick when the combo does not exist", () => {
    expect(
      resolveDevinPairingUid(pairing, {
        lead: "gpt-6-sol",
        effort: "xhigh",
        fast: false,
        sidekick: "swe-2-medium",
      }),
    ).toBe("fusion-gpt-6-sol-xhigh-sidekick-glm-5-2");
  });

  it("keeps effort and sidekick when the lead has no fast variant", () => {
    expect(
      resolveDevinPairingUid(pairing, {
        lead: "gpt-6-sol",
        effort: "xhigh",
        fast: true,
        sidekick: "glm-5-2",
      }),
    ).toBe("fusion-gpt-6-sol-xhigh-sidekick-glm-5-2");
  });
});

describe("currentDevinPairing / buildDevinPairingPatch / status label", () => {
  const pairing = getDevinPairingModel("devin", fusionRuntimeModel())!;

  it("parses the pinned variant back into parts", () => {
    const selection = currentDevinPairing(pairing, {
      modelVariant: "fusion-claude-fable-5-1-low-fast-sidekick-swe-2-medium",
    });
    // The pinned UID does not exist in the family, so the compose baseline
    // falls back to the first variant instead of inventing parts.
    expect(selection.explicit).toBe(false);

    const pinned = currentDevinPairing(pairing, {
      modelVariant: "fusion-claude-fable-5-1-high-fast-sidekick-swe-2-medium",
    });
    expect(pinned.explicit).toBe(true);
    expect(pinned.parts).toEqual({
      lead: "claude-fable-5-1",
      effort: "high",
      fast: true,
      sidekick: "swe-2-medium",
    });
  });

  it("uses the first variant as baseline while nothing is pinned", () => {
    const selection = currentDevinPairing(pairing, undefined);
    expect(selection.explicit).toBe(false);
    expect(selection.parts.lead).toBe("claude-fable-5-1");
    expect(selection.parts.sidekick).toBe("swe-2-medium");
  });

  it("clears generic traits so the pinned variant wins resolution", () => {
    expect(buildDevinPairingPatch("fusion-a")).toEqual({
      modelVariant: "fusion-a",
      reasoningEffort: undefined,
      fastMode: undefined,
      thinking: undefined,
      contextWindow: undefined,
    });
  });

  it("labels the pinned pairing for the composer trigger", () => {
    expect(
      devinPairingStatusLabel(pairing, {
        modelVariant: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
      }),
    ).toBe("Claude Fable 5.1 High + SWE-2 Medium");
    expect(devinPairingStatusLabel(pairing, undefined)).toBeNull();
    expect(devinPairingStatusLabel(null, { modelVariant: "x" })).toBeNull();
  });
});
