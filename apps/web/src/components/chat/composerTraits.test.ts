import { afterEach, describe, expect, it } from "vitest";
import { setLanguagePreference } from "~/i18n";

import {
  getComposerTraitSelection,
  planComposerEffortChange,
  planComposerEffortCycle,
  resolveComposerEffortLadderIndex,
  resolveComposerTraitStatusLabel,
} from "./composerTraits";

afterEach(() => setLanguagePreference("system"));

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

describe("CLI-discovered Claude effort", () => {
  it("uses only native levels and rejects the synthetic default from a cached catalog", () => {
    const selection = getComposerTraitSelection(
      "claudeAgent",
      "runtime-fixture-model",
      "",
      { effort: "max" },
      {
        slug: "runtime-fixture-model",
        name: "Runtime fixture",
        supportsThinkingToggle: false,
        supportedReasoningEfforts: [
          { value: "default", label: "Default" },
          { value: "low" },
          { value: "max" },
        ],
        defaultReasoningEffort: "default",
      },
    );
    expect(selection.effortLevels.map((level) => level.value)).toEqual(["low", "max"]);
    expect(selection.defaultEffort).toBe("low");
    expect(selection.effort).toBe("max");
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection,
        prompt: "",
        value: "default",
      }),
    ).toBeNull();
  });
});

describe("localized composer trait presentation", () => {
  it.each([
    ["en", "Medium"],
    ["zh-CN", "中"],
  ] as const)(
    "shows generated effort labels in %s while committing unchanged option IDs",
    (locale, label) => {
      setLanguagePreference(locale);
      const selection = getComposerTraitSelection(
        "codex",
        "custom-model",
        "Keep this prompt",
        undefined,
        {
          slug: "custom-model",
          name: "Custom model",
          supportedReasoningEfforts: [{ value: "medium" }, { value: "high" }],
          defaultReasoningEffort: "medium",
        },
      );
      expect(resolveComposerTraitStatusLabel(selection)).toBe(label);
      expect(
        planComposerEffortChange({
          provider: "codex",
          selection,
          prompt: "Keep this prompt",
          value: "high",
        }),
      ).toEqual({ kind: "options", patch: { reasoningEffort: "high" } });
    },
  );

  it("preserves explicit provider effort labels and descriptions even when they resemble UI copy", () => {
    setLanguagePreference("zh-CN");
    const selection = getComposerTraitSelection("codex", "custom-model", "", undefined, {
      slug: "custom-model",
      name: "Custom model",
      supportedReasoningEfforts: [
        { value: "medium", label: "Medium", description: "Provider guidance" },
        { value: "high", label: "chat:effortHigh" },
      ],
      defaultReasoningEffort: "medium",
    });
    expect(selection.effortLevels).toEqual([
      { value: "medium", label: "Medium", description: "Provider guidance", isDefault: true },
      { value: "high", label: "chat:effortHigh" },
    ]);
    const descriptorSelection = getComposerTraitSelection("codex", "custom-model", "", undefined, {
      slug: "custom-model",
      name: "Custom model",
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Provider effort",
          type: "select",
          options: [
            { id: "medium", label: "Provider medium" },
            { id: "high", label: "Provider high" },
          ],
        },
      ],
    });
    expect(descriptorSelection.primarySelectDescriptor?.label).toBe("Provider effort");
    expect(resolveComposerTraitStatusLabel(descriptorSelection)).toBe("Provider medium");
  });

  it("localizes canonical labels constructed by the Claude adapter while preserving custom overrides", () => {
    setLanguagePreference("zh-CN");
    const selection = getComposerTraitSelection("claudeAgent", "custom-model", "", undefined, {
      slug: "custom-model",
      name: "Custom model",
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "Provider deep work" },
          ],
        },
      ],
      supportedReasoningEfforts: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "Provider deep work" },
      ],
    });
    expect(resolveComposerTraitStatusLabel(selection)).toBe("中");
    expect(selection.effortLevels.find((option) => option.value === "high")?.label).toBe(
      "Provider deep work",
    );
  });

  it("localizes thinking and automatic context labels without changing context values or prompt modes", () => {
    setLanguagePreference("zh-CN");
    const thinking = getComposerTraitSelection(
      "codex",
      "custom-model",
      "",
      { thinking: false },
      {
        slug: "custom-model",
        name: "Custom model",
        supportsThinkingToggle: true,
      },
    );
    expect(resolveComposerTraitStatusLabel(thinking)).toBe("思考已关闭");
    const prompt = "Ultrathink:\nKeep this prompt";
    const claude = getComposerTraitSelection("claudeAgent", "claude-opus-4-8", prompt, {
      effort: "low",
    });
    expect(claude.contextWindowDescriptor?.label).toBe("自动压缩");
    expect(claude.contextWindowOptions[0]).toMatchObject({
      value: "auto",
      label: "自动（Claude Code）",
    });
    expect(
      planComposerEffortCycle({ provider: "claudeAgent", selection: claude, prompt }),
    ).toBeNull();
  });
});
