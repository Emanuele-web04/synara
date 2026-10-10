import { describe, expect, it } from "vitest";

import {
  getComposerTraitSelection,
  planComposerEffortChange,
  planComposerEffortCycle,
  resolveComposerEffortLadderIndex,
  resolveComposerTraitStatusLabel,
} from "./composerTraits";

describe("planComposerEffortCycle", () => {
  it.each([
    ["low", "medium"],
    ["medium", "high"],
    ["high", "xhigh"],
    ["xhigh", "low"],
  ] as const)("advances Codex effort from %s to %s", (current, next) => {
    const prompt = "Fix the flaky test";
    const selection = getComposerTraitSelection("codex", "gpt-5.5", prompt, {
      reasoningEffort: current,
    });

    expect(planComposerEffortCycle({ provider: "codex", selection, prompt })).toEqual({
      kind: "options",
      patch: { reasoningEffort: next },
    });
  });

  it("advances from the model's default when no effort override exists", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", undefined);

    expect(planComposerEffortCycle({ provider: "codex", selection, prompt: "" })).toEqual({
      kind: "options",
      patch: { reasoningEffort: "high" },
    });
  });

  it("ignores models without an effort ladder or with only one effort level", () => {
    const absent = getComposerTraitSelection("codex", "custom-model", "", undefined);
    const single = getComposerTraitSelection("codex", "custom-model", "", undefined, {
      slug: "custom-model",
      name: "Custom model",
      supportedReasoningEfforts: [{ value: "high", label: "High" }],
      defaultReasoningEffort: "high",
    });

    expect(
      planComposerEffortCycle({ provider: "codex", selection: absent, prompt: "" }),
    ).toBeNull();
    expect(
      planComposerEffortCycle({ provider: "codex", selection: single, prompt: "" }),
    ).toBeNull();
  });

  it("preserves the prompt lock when Ultrathink controls effort", () => {
    const prompt = "Ultrathink:\nFix the flaky test";
    const selection = getComposerTraitSelection("claudeAgent", "claude-opus-4-8", prompt, {
      effort: "low",
    });

    expect(planComposerEffortCycle({ provider: "claudeAgent", selection, prompt })).toBeNull();
  });

  it.each([
    ["max", "ultracode"],
    ["ultracode", "low"],
  ] as const)(
    "skips prompt-injected Ultrathink from %s without rewriting the draft",
    (current, next) => {
      const prompt = "Fix the flaky test";
      const selection = getComposerTraitSelection("claudeAgent", "claude-opus-4-8", prompt, {
        effort: current,
      });

      expect(planComposerEffortCycle({ provider: "claudeAgent", selection, prompt })).toEqual({
        kind: "options",
        patch: { effort: next },
      });
    },
  );

  it("ignores a ladder with only one persisted level after excluding prompt injection", () => {
    const selection = getComposerTraitSelection("claudeAgent", "custom-model", "", undefined, {
      slug: "custom-model",
      name: "Custom model",
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        },
      ],
    });

    expect(planComposerEffortCycle({ provider: "claudeAgent", selection, prompt: "" })).toBeNull();
  });

  it("uses the OpenCode runtime variant descriptor without cycling context options", () => {
    const selection = getComposerTraitSelection(
      "opencode",
      "acme/custom-model",
      "",
      {
        variant: "economy",
      },
      {
        slug: "acme/custom-model",
        name: "Custom model",
        optionDescriptors: [
          {
            id: "contextWindow",
            label: "Context window",
            type: "select",
            options: [
              { id: "200k", label: "200K", isDefault: true },
              { id: "1m", label: "1M" },
            ],
          },
          {
            id: "variant",
            label: "Variant",
            type: "select",
            options: [
              { id: "economy", label: "Economy", isDefault: true },
              { id: "turbo", label: "Turbo" },
            ],
          },
        ],
      },
    );

    expect(planComposerEffortCycle({ provider: "opencode", selection, prompt: "" })).toEqual({
      kind: "options",
      patch: { variant: "turbo" },
    });
  });

  it("persists OMP runtime effort choices under thinkingLevel", () => {
    const selection = getComposerTraitSelection(
      "omp",
      "acme/custom-model",
      "",
      {
        thinkingLevel: "off",
      },
      {
        slug: "acme/custom-model",
        name: "Custom model",
        supportedReasoningEfforts: [
          { value: "off", label: "Off" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "off",
      },
    );

    expect(planComposerEffortCycle({ provider: "omp", selection, prompt: "" })).toEqual({
      kind: "options",
      patch: { thinkingLevel: "high" },
    });
  });
});

describe("planComposerEffortChange", () => {
  it("rewrites the prompt for prompt-injected levels", () => {
    const selection = getComposerTraitSelection("claudeAgent", "claude-opus-4-8", "", undefined);

    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection,
        prompt: "",
        value: "ultrathink",
      }),
    ).toEqual({ kind: "prompt", prompt: "Ultrathink:\n" });
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection,
        prompt: "Fix the flaky test",
        value: "ultrathink",
      }),
    ).toEqual({ kind: "prompt", prompt: "Ultrathink:\nFix the flaky test" });
  });

  it("ignores changes while Ultrathink pins the effort and for unknown values", () => {
    const pinned = getComposerTraitSelection(
      "claudeAgent",
      "claude-opus-4-8",
      "Ultrathink:\nGo",
      undefined,
    );
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection: pinned,
        prompt: "Ultrathink:\nGo",
        value: "low",
      }),
    ).toBeNull();

    const free = getComposerTraitSelection("codex", "gpt-5.5", "", undefined);
    expect(
      planComposerEffortChange({ provider: "codex", selection: free, prompt: "", value: "turbo" }),
    ).toBeNull();
    expect(
      planComposerEffortChange({ provider: "codex", selection: free, prompt: "", value: "" }),
    ).toBeNull();
  });
});

describe("Devin Fusion pairing selection", () => {
  const FUSION_RUNTIME_MODEL = {
    slug: "fusion",
    name: "Fusion",
    modelVariants: [
      {
        model: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
        label: "Fusion (Claude Fable 5.1 High + SWE-2 Medium)",
        reasoningEffort: "medium",
        fastMode: false,
      },
      {
        model: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
        label: "Fusion (GPT-6 Sol Extra High Thinking + GLM-5.2)",
        reasoningEffort: "xhigh",
        fastMode: false,
      },
    ],
  };

  it("exposes the pairing and reports the pinned variant as the status label", () => {
    const selection = getComposerTraitSelection(
      "devin",
      "fusion",
      "",
      undefined,
      FUSION_RUNTIME_MODEL,
    );
    expect(selection.pairing).not.toBeNull();
    expect(selection.pairingVariantUid).toBeNull();
    expect(selection.pairingLabel).toBe("Default");

    const pinned = getComposerTraitSelection(
      "devin",
      "fusion",
      "",
      {
        modelVariant: "fusion-gpt-6-sol-xhigh-sidekick-glm-5-2",
      },
      FUSION_RUNTIME_MODEL,
    );
    expect(pinned.pairingVariantUid).toBe("fusion-gpt-6-sol-xhigh-sidekick-glm-5-2");
    expect(pinned.pairingLabel).toBe("GPT-6 Sol Extra High Thinking + GLM-5.2");
    expect(resolveComposerTraitStatusLabel(pinned)).toBe("GPT-6 Sol Extra High Thinking + GLM-5.2");
  });

  it("drops a pinned variant that does not belong to the family", () => {
    const selection = getComposerTraitSelection(
      "devin",
      "fusion",
      "",
      {
        modelVariant: "fusion-unknown-lead-high-sidekick-swe-2-medium",
      },
      FUSION_RUNTIME_MODEL,
    );
    expect(selection.pairingVariantUid).toBeNull();
    expect(selection.pairingLabel).toBe("Default");
  });

  it("exposes no pairing for ordinary Devin models", () => {
    const selection = getComposerTraitSelection("devin", "swe-2", "", {
      modelVariant: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
    });
    expect(selection.pairing).toBeNull();
    expect(selection.pairingVariantUid).toBeNull();
    expect(selection.pairingLabel).toBeNull();
  });
});

describe("resolveComposerEffortLadderIndex", () => {
  it("follows the selected effort and falls back to the first stop", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", {
      reasoningEffort: "high",
    });
    expect(resolveComposerEffortLadderIndex(selection)).toBe(
      selection.effortLevels.findIndex((level) => level.value === "high"),
    );
    expect(resolveComposerEffortLadderIndex({ ...selection, effort: "unknown" })).toBe(0);
  });

  it("rests on the prompt-injected stop while Ultrathink pins the ladder", () => {
    const selection = getComposerTraitSelection(
      "claudeAgent",
      "claude-opus-4-8",
      "Ultrathink:\nGo",
      undefined,
    );
    expect(selection.ultrathinkPromptControlled).toBe(true);
    expect(resolveComposerEffortLadderIndex(selection)).toBe(
      selection.effortLevels.findIndex((level) => level.value === "ultrathink"),
    );
  });
});
